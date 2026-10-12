import { Router, Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth.middleware';
import { query } from '../config/database';
import logger from '../config/logger';
import crypto from 'crypto';
import { sendInvitationEmail } from '../services/email.service';
import { WorkspaceSyncService } from '../services/workspace.service';
import { syncScholarSyncAdminRole } from '../services/ssAccountSync.service';

const router = Router();

/**
 * POST /api/organizations
 * Create a new organization
 */
router.post('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, domain } = req.body;
    const userId = req.user!.id;

    if (!name) {
      return res.status(400).json({ error: 'Organization name is required' });
    }

    // Create organization
    const orgResult = await query(
      `INSERT INTO organizations (name, description, domain) 
       VALUES ($1, $2, $3) RETURNING *`,
      [name, description, domain]
    );

    const organization = orgResult.rows[0];

    // Add creator as admin
    await query(
      `INSERT INTO organization_members (organization_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [organization.id, userId, 'admin', 'active']
    );

    // The org creator is an Admin — immediately grant them ScholarSync Admin too
    const creator = await query('SELECT name, email FROM users WHERE id = $1', [userId]);
    await syncScholarSyncAdminRole(creator.rows[0]?.email, creator.rows[0]?.name, userId);

    logger.info(`Organization created: ${organization.id} by user ${userId}`);
    res.status(201).json(organization);
  } catch (error) {
    logger.error('Error creating organization:', error);
    res.status(500).json({ error: 'Failed to create organization' });
  }
});

/**
 * GET /api/organizations
 * Get user's organizations
 */
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const result = await query(
      `SELECT o.*, om.role, om.status, om.joined_at
       FROM organizations o
       INNER JOIN organization_members om ON o.id = om.organization_id
       WHERE om.user_id = $1 AND om.status = $2
       ORDER BY o.created_at DESC`,
      [userId, 'active']
    );

    // DEBUG: Log what we're returning
    console.log('='.repeat(70));
    console.log('🔍 GET /api/organizations - User:', req.user!.email);
    console.log('📋 Returning organizations:');
    result.rows.forEach(org => {
      console.log(`   - ${org.name}: role=${org.role}, status=${org.status}`);
    });
    console.log('='.repeat(70));

    res.json(result.rows);
  } catch (error) {
    logger.error('Error fetching organizations:', error);
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
});

/**
 * GET /api/organizations/:id
 * Get organization details
 */
router.get('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Check if user is member
    const memberCheck = await query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = $3',
      [id, userId, 'active']
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const orgResult = await query('SELECT * FROM organizations WHERE id = $1', [id]);

    if (orgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Get member count
    const memberCount = await query(
      'SELECT COUNT(*) FROM organization_members WHERE organization_id = $1 AND status = $2',
      [id, 'active']
    );

    // Get project count
    const projectCount = await query(
      'SELECT COUNT(*) FROM projects WHERE organization_id = $1',
      [id]
    );

    const organization = {
      ...orgResult.rows[0],
      memberCount: parseInt(memberCount.rows[0].count),
      projectCount: parseInt(projectCount.rows[0].count),
      userRole: memberCheck.rows[0].role,
    };

    res.json(organization);
  } catch (error) {
    logger.error('Error fetching organization:', error);
    res.status(500).json({ error: 'Failed to fetch organization' });
  }
});

/**
 * PUT /api/organizations/:id
 * Update organization (admin only)
 */
router.put('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, domain, logo_url } = req.body;
    const userId = req.user!.id;

    // Check if user is admin
    const roleCheck = await query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (roleCheck.rows.length === 0 || roleCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await query(
      `UPDATE organizations 
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           domain = COALESCE($3, domain),
           logo_url = COALESCE($4, logo_url)
       WHERE id = $5
       RETURNING *`,
      [name, description, domain, logo_url, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Error updating organization:', error);
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

/**
 * POST /api/organizations/:id/invite
 * Invite user to organization (admin/manager only)
 */
router.post('/:id/invite', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { email, role } = req.body;
    const userId = req.user!.id;

    if (!email || !role) {
      return res.status(400).json({ error: 'Email and role are required' });
    }

    if (!['admin', 'manager', 'member', 'adviser'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Check if user has permission to invite
    const roleCheck = await query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (roleCheck.rows.length === 0 || !['admin', 'manager'].includes(roleCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    // Generate invitation token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry

    // Create invitation
    const inviteResult = await query(
      `INSERT INTO organization_invitations (organization_id, email, role, token, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, email) 
       DO UPDATE SET token = $4, expires_at = $6, invited_by = $5
       RETURNING *`,
      [id, email, role, token, userId, expiresAt]
    );

    // Get inviter and organization name for email
    const orgResult = await query('SELECT name FROM organizations WHERE id = $1', [id]);
    const userResult = await query('SELECT name, email FROM users WHERE id = $1', [userId]);
    const orgName = orgResult.rows[0]?.name || 'Organization';
    const inviterName = userResult.rows[0]?.name || 'A team member';
    const inviterEmail = userResult.rows[0]?.email || '';

    // Send invitation email
    const emailResult = await sendInvitationEmail({
      to: email,
      inviterName,
      inviterEmail,
      organizationName: orgName,
      role,
      token
    });

    if (emailResult.success) {
      logger.info(`✅ Invitation email sent to ${email} for organization ${id}`);
    } else {
      logger.warn(`⚠️ Invitation email failed for ${email}: ${emailResult.error}`);
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://skyflow.fun';

    res.status(201).json({
      message: 'Invitation sent successfully',
      inviteUrl: `${frontendUrl}/invite/accept?token=${token}`,
    });
  } catch (error) {
    logger.error('Error creating invitation:', error);
    res.status(500).json({ error: 'Failed to create invitation' });
  }
});

/**
 * GET /api/organizations/:id/members
 * Get organization members (includes ghost/invited members from sheet syncs)
 */
router.get('/:id/members', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Check if user is member
    const memberCheck = await query(
      'SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = $3',
      [id, userId, 'active']
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get real members (users with accounts)
    // LEFT JOIN ss_account (via the user_id bridge from migration 038, falling back
    // to a case-insensitive email match) so each member's ScholarSync academic role
    // (Student / Adviser / Admin / External Leader) is unified alongside their
    // SkyFlow organization role — e.g. a member can be shown as "Member & Student".
    const realMembers = await query(
      `SELECT u.id, u.name, u.email, u.profile_picture,
              om.role, om.status, om.joined_at,
              (
                SELECT sa."accountRole" FROM ss_account sa
                WHERE sa.user_id = u.id
                   OR LOWER(TRIM(sa."accountEmail")) = LOWER(TRIM(u.email))
                ORDER BY (sa.user_id = u.id) DESC
                LIMIT 1
              ) as academic_role
       FROM organization_members om
       INNER JOIN users u ON om.user_id = u.id
       WHERE om.organization_id = $1
       ORDER BY om.joined_at DESC`,
      [id]
    );

    // Get ghost/invited members (discovered from sheets, no user account yet)
    const ghostMembers = await query(
      `SELECT 
         om.id as id,
         om.invited_email as name,
         om.invited_email as email,
         NULL as profile_picture,
         om.role,
         om.status,
         om.invited_at as joined_at
       FROM organization_members om
       WHERE om.organization_id = $1 
         AND om.status = 'invited'
         AND om.user_id IS NULL
       ORDER BY om.invited_at DESC`,
      [id]
    );

    const allMembers = [...realMembers.rows, ...ghostMembers.rows];

    res.json({ members: allMembers });
  } catch (error) {
    logger.error('Error fetching members:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

/**
 * DELETE /api/organizations/:id/members/:userId
 * Remove member from organization (admin only)
 */
router.delete('/:id/members/:memberId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id, memberId } = req.params;
    const userId = req.user!.id;

    // Check if user is admin
    const roleCheck = await query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (roleCheck.rows.length === 0 || roleCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await query(
      'DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [id, memberId]
    );

    res.json({ message: 'Member removed successfully' });
  } catch (error) {
    logger.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

/**
 * GET /api/organizations/:id/projects
 * Get all projects in organization
 */
router.get('/:id/projects', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Check if user is member
    const memberCheck = await query(
      'SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = $3',
      [id, userId, 'active']
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await query(
      `SELECT p.*, u.name as created_by_name,
              COUNT(DISTINCT t.id) as task_count
       FROM projects p
       LEFT JOIN users u ON p.created_by = u.id
       LEFT JOIN tasks t ON p.id = t.project_id
       WHERE p.organization_id = $1
       GROUP BY p.id, u.name
       ORDER BY p.created_at DESC`,
      [id]
    );

    res.json({ projects: result.rows });
  } catch (error) {
    logger.error('Error fetching organization projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

/**
 * GET /api/organizations/:id/tasks
 * Get all tasks in organization (including synced sheet tasks)
 */
router.get('/:id/tasks', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { team_id, status, exclude_status, project_id, limit, offset } = req.query;
    const userId = req.user!.id;

    // Check if user is member and capture their org role for visibility scoping
    const memberCheck = await query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = $3',
      [id, userId, 'active']
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const orgRole = memberCheck.rows[0].role as string;
    // Email is needed to match sheet-task assignees and team-membership rows that
    // key off email (campus vs. Google address) — mirrors the team-groups scoping.
    const emailRow = await query('SELECT email FROM users WHERE id = $1', [userId]);
    const userEmail: string | null = emailRow.rows[0]?.email || null;

    // Build filter conditions, applied identically to both UNION branches
    let teamFilter = '';
    let teamFilterSheet = '';
    let statusFilter = '';
    let statusFilterSheet = '';
    let excludeStatusFilter = '';
    let excludeStatusFilterSheet = '';
    let projectFilter = '';
    let projectFilterSheet = '';
    let queryParams: any[] = [id];

    if (team_id && team_id !== 'all') {
      // Strict team filter: only show tasks belonging to the selected team.
      // Null-team tasks are only visible when "All Teams" is selected.
      queryParams.push(team_id);
      const idx = queryParams.length;
      teamFilter = `AND t.team_id = $${idx}`;
      teamFilterSheet = `AND COALESCE(st.team_id, ss.team_id) = $${idx}`;
    }

    if (status) {
      const statusList = String(status).split(',').map(s => s.trim()).filter(Boolean);
      if (statusList.length > 0) {
        queryParams.push(statusList);
        const idx = queryParams.length;
        statusFilter = `AND t.status = ANY($${idx})`;
        statusFilterSheet = `AND st.status = ANY($${idx})`;
      }
    }

    if (exclude_status) {
      const excludeList = String(exclude_status).split(',').map(s => s.trim()).filter(Boolean);
      if (excludeList.length > 0) {
        queryParams.push(excludeList);
        const idx = queryParams.length;
        excludeStatusFilter = `AND t.status != ALL($${idx})`;
        excludeStatusFilterSheet = `AND st.status != ALL($${idx})`;
      }
    }

    if (project_id) {
      queryParams.push(project_id);
      const idx = queryParams.length;
      projectFilter = `AND t.project_id = $${idx}`;
      projectFilterSheet = `AND st.project_id = $${idx}`;
    }

    // ── Role-based visibility (Rev 1 members / Rev 6 team leaders) ──────────────
    // admin & adviser oversee the whole org (no extra filter). A manager (team
    // leader) is scoped to the team(s)/project(s) they belong to or lead; a member
    // sees only tasks assigned to them.
    let visibilityFilter = '';
    let visibilityFilterSheet = '';
    if (orgRole === 'member' || orgRole === 'manager') {
      queryParams.push(userId);
      const meIdx = queryParams.length;
      queryParams.push(userEmail);
      const emailIdx = queryParams.length;

      // Teams the user belongs to / leads (matched by user_id OR email).
      const myTeams = `SELECT team_group_id FROM team_group_members
                       WHERE user_id = $${meIdx}
                          OR ($${emailIdx}::text IS NOT NULL AND LOWER(email) = LOWER($${emailIdx}))`;

      if (orgRole === 'member') {
        visibilityFilter = `AND (t.assigned_to = $${meIdx}
           OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $${meIdx}))`;
        visibilityFilterSheet = `AND (
           ($${emailIdx}::text IS NOT NULL AND LOWER(st.assignee_email) = LOWER($${emailIdx}))
           OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = st.id AND ta.user_id = $${meIdx})
        )`;
      } else {
        // Projects the manager is tied to: created, a member of, or linked to their teams.
        const myProjects = `SELECT id FROM projects WHERE created_by = $${meIdx}
           UNION SELECT project_id FROM project_members WHERE user_id = $${meIdx}
           UNION SELECT project_id FROM team_groups WHERE project_id IS NOT NULL AND id IN (${myTeams})`;
        visibilityFilter = `AND (t.created_by = $${meIdx}
           OR t.assigned_to = $${meIdx}
           OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $${meIdx})
           OR t.team_id IN (${myTeams})
           OR t.project_id IN (${myProjects}))`;
        visibilityFilterSheet = `AND (($${emailIdx}::text IS NOT NULL AND LOWER(st.assignee_email) = LOWER($${emailIdx}))
           OR COALESCE(st.team_id, ss.team_id) IN (${myTeams})
           OR st.project_id IN (${myProjects}))`;
      }
    }

    let limitClause = '';
    const parsedLimit = limit ? parseInt(String(limit), 10) : NaN;
    const parsedOffset = offset ? parseInt(String(offset), 10) : NaN;
    if (!isNaN(parsedLimit) && parsedLimit > 0) {
      queryParams.push(parsedLimit);
      limitClause += ` LIMIT $${queryParams.length}`;
      if (!isNaN(parsedOffset) && parsedOffset >= 0) {
        queryParams.push(parsedOffset);
        limitClause += ` OFFSET $${queryParams.length}`;
      }
    }

    // Query includes both regular tasks AND synced sheet_tasks
    const result = await query(
      `SELECT * FROM (
       SELECT t.id, t.project_id, t.team_id, t.title, t.description, t.status, t.priority,
              t.due_date, t.estimated_hours, t.actual_hours, t.assigned_to, t.created_by,
              t.created_at, t.updated_at, t.is_absolute, t.complexity_weight, t.wbs_code, t.parent_task_id,
              t.progress_percent, t.luxury_weight,
              p.name as project_name,
              tg.name as team_name,
              u1.name as assigned_to_name,
              u1.email as assigned_to_email,
              u2.name as created_by_name,
              'app' as source_type,
              NULL as sheet_name,
              NULL as google_sheet_id,
              (SELECT COUNT(*) FROM task_comments WHERE task_id = t.id)::integer as comment_count
       FROM tasks t
       LEFT JOIN projects p ON t.project_id = p.id
       LEFT JOIN team_groups tg ON t.team_id = tg.id
       LEFT JOIN users u1 ON t.assigned_to = u1.id
       LEFT JOIN users u2 ON t.created_by = u2.id
       WHERE p.organization_id = $1 ${teamFilter} ${statusFilter} ${excludeStatusFilter} ${projectFilter} ${visibilityFilter}

       UNION ALL
       
       SELECT 
         st.id,
         st.project_id,
         COALESCE(st.team_id, ss.team_id) as team_id,
         st.title,
         st.description,
         st.status,
         st.priority,
         st.due_date,
         NULL::integer as estimated_hours,
         NULL::integer as actual_hours,
         NULL::uuid as assigned_to,
         NULL::uuid as created_by,
         st.created_at,
         st.updated_at,
         st.is_absolute,
         st.complexity_weight,
         st.wbs_code,
         st.parent_task_id,
         st.progress_percent,
         st.luxury_weight,
         COALESCE(p.name, NULL) as project_name,
         NULL as team_name,
         st.assignee_email as assigned_to_name,
         st.assignee_email as assigned_to_email,
         'Google Sheets' as created_by_name,
         'sheet' as source_type,
         ss.sheet_name,
         ss.sheet_id as google_sheet_id,
         (SELECT COUNT(*) FROM task_comments WHERE task_id = st.id)::integer as comment_count
       FROM sheet_tasks st
       JOIN synced_sheets ss ON st.synced_sheet_id = ss.id
       JOIN workspaces w ON ss.workspace_id = w.id
       LEFT JOIN projects p ON st.project_id = p.id
       WHERE w.organization_id = $1 ${teamFilterSheet} ${statusFilterSheet} ${excludeStatusFilterSheet} ${projectFilterSheet} ${visibilityFilterSheet}
       ) combined
       ORDER BY created_at DESC
       ${limitClause}`,
      queryParams
    );

    // Attach assignees from junction table to all tasks (app and sheet)
    const taskIds = result.rows.map((t: any) => t.id);
    if (taskIds.length > 0) {
      const assigneesResult = await query(
        `SELECT ta.task_id, ta.user_id, u.name, u.email, u.profile_picture
         FROM task_assignees ta
         JOIN users u ON ta.user_id = u.id
         WHERE ta.task_id = ANY($1)`,
        [taskIds]
      );
      const byTask: Record<string, any[]> = {};
      for (const a of assigneesResult.rows) {
        if (!byTask[a.task_id]) byTask[a.task_id] = [];
        byTask[a.task_id].push({ user_id: a.user_id, name: a.name, email: a.email, profile_picture: a.profile_picture });
      }
      for (const task of result.rows) {
        task.assignees = byTask[task.id] || [];
      }
    }

    logger.debug(`Found ${result.rows.length} tasks for organization: ${id}`);
    res.json({ tasks: result.rows });
  } catch (error) {
    logger.error('Error fetching organization tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

/**
 * GET /api/organizations/:id/synced-sheets
 * Get all synced sheets in organization
 */
router.get('/:id/synced-sheets', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { team_id } = req.query;
    const userId = req.user!.id;

    // Check if user is member
    const memberCheck = await query(
      'SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = $3',
      [id, userId, 'active']
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Team-specific storage: each team has its own WBS
    let teamFilter = '';
    const params: any[] = [id];
    if (team_id && team_id !== 'all') {
      teamFilter = 'AND ss.team_id = $2';
      params.push(team_id);
    }

    const result = await query(
      `SELECT ss.*, w.name as workspace_name,
              (SELECT COUNT(*) FROM sheet_tasks WHERE synced_sheet_id = ss.id) as task_count
       FROM synced_sheets ss
       JOIN workspaces w ON ss.workspace_id = w.id
       WHERE w.organization_id = $1 ${teamFilter}
       ORDER BY ss.created_at DESC`,
      params
    );

    res.json({ syncedSheets: result.rows });
  } catch (error) {
    logger.error('Error fetching synced sheets:', error);
    res.status(500).json({ error: 'Failed to fetch synced sheets' });
  }
});

/**
 * POST /api/organizations/:id/tasks
 * Create a task in organization (creates a default project if needed)
 */
router.post('/:id/tasks', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      title, description, status, priority, due_date,
      assigned_to, start_date, is_absolute, complexity_weight,
      wbs_code, parent_task_id, team_id, project_id
    } = req.body;
    const userId = req.user!.id;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    // Project is required — a task must belong to a specific project.
    if (!project_id) {
      return res.status(400).json({ error: 'Project is required' });
    }

    // Check if user is member
    const memberCheck = await query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = $3',
      [id, userId, 'active']
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const orgRole = memberCheck.rows[0].role as string;

    // The chosen project must exist in this organization.
    const projectCheck = await query(
      'SELECT id FROM projects WHERE id = $1 AND organization_id = $2',
      [project_id, id]
    );
    if (projectCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found in this organization' });
    }

    // A manager (team leader) may only assign tasks to projects they are under:
    // ones they created, are a member of, or that are linked to a team they're in.
    if (orgRole === 'manager') {
      const scopedCheck = await query(
        `SELECT 1 FROM projects p WHERE p.id = $1 AND (
           p.created_by = $2
           OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2)
           OR EXISTS (
             SELECT 1 FROM team_groups tg
             JOIN team_group_members tgm ON tgm.team_group_id = tg.id
             WHERE tg.project_id = p.id
               AND (tgm.user_id = $2 OR LOWER(tgm.email) = LOWER((SELECT email FROM users WHERE id = $2)))
           )
         )`,
        [project_id, userId]
      );
      if (scopedCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You can only assign tasks to projects you are part of.' });
      }
    }

    const projectId = project_id;

    // Resolve parent: it may live in `tasks` OR `sheet_tasks` (WBS).
    // tasks.parent_task_id has FK → tasks(id), so if parent is a sheet_task
    // we must NULL out parent_task_id and derive WBS code from it instead.
    let parentWbsCode: string | null = null;
    let effectiveParentTaskId: string | null = parent_task_id || null;
    if (parent_task_id) {
      const parentInTasks = await query('SELECT wbs_code FROM tasks WHERE id = $1', [parent_task_id]);
      if (parentInTasks.rows.length > 0) {
        parentWbsCode = parentInTasks.rows[0].wbs_code;
      } else {
        const parentInSheetTasks = await query('SELECT wbs_code FROM sheet_tasks WHERE id = $1', [parent_task_id]);
        if (parentInSheetTasks.rows.length > 0) {
          parentWbsCode = parentInSheetTasks.rows[0].wbs_code;
          // Cannot store FK to sheet_tasks in tasks.parent_task_id → null it
          effectiveParentTaskId = null;
        } else {
          // Parent not found anywhere → treat as root
          effectiveParentTaskId = null;
        }
      }
    }

    // Auto-generate WBS code if not provided
    let finalWbsCode = wbs_code;
    if (!finalWbsCode) {
      if (parentWbsCode) {
        // Count siblings across BOTH tables to produce a unique WBS code
        const siblingsInTasks = await query(
          `SELECT COUNT(*) FROM tasks WHERE wbs_code LIKE $1`,
          [`${parentWbsCode}.%`]
        );
        const siblingsInSheetTasks = await query(
          `SELECT COUNT(*) FROM sheet_tasks WHERE wbs_code LIKE $1`,
          [`${parentWbsCode}.%`]
        );
        const siblingCount =
          parseInt(siblingsInTasks.rows[0].count) +
          parseInt(siblingsInSheetTasks.rows[0].count) + 1;
        finalWbsCode = `${parentWbsCode}.${siblingCount}`;
      } else {
        const countResult = await query(
          'SELECT COUNT(*) FROM tasks WHERE parent_task_id IS NULL AND project_id = $1',
          [projectId]
        );
        const rootCount = parseInt(countResult.rows[0].count) + 1;
        finalWbsCode = `${rootCount}`;
      }
    }

    // Create task
    const taskResult = await query(
      `INSERT INTO tasks (
        project_id, team_id, title, description, status, priority,
        due_date, start_date, assigned_to, created_by,
        is_absolute, complexity_weight, wbs_code, parent_task_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        projectId, team_id || null, title, description, status || 'todo', priority || 'medium',
        due_date || null, start_date || null, assigned_to || null, userId,
        is_absolute || false, complexity_weight || 1, finalWbsCode, effectiveParentTaskId
      ]
    );

    logger.info(`Task created in organization ${id}: ${taskResult.rows[0].id}`);
    res.status(201).json(taskResult.rows[0]);
  } catch (error) {
    logger.error('Error creating organization task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

/**
 * POST /api/organizations/:id/tasks/google-sync
 * Connect and sync a Google Sheet to the Kanban board
 */
router.post('/:id/tasks/google-sync', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { sheet_id, sheet_name, project_id, team_id } = req.body;
    const userId = req.user!.id;

    if (!sheet_id) return res.status(400).json({ error: 'Sheet ID is required' });

    // 1. Find or create workspace for this organization/user
    let workspaceResult = await query(
      'SELECT id FROM workspaces WHERE organization_id = $1 AND created_by = $2',
      [id, userId]
    );

    let workspaceId;
    if (workspaceResult.rows.length === 0) {
      const newWs = await query(
        `INSERT INTO workspaces (organization_id, created_by, name, root_folder_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [id, userId, 'Default Workspace', 'root']
      );
      workspaceId = newWs.rows[0].id;
    } else {
      workspaceId = workspaceResult.rows[0].id;
    }

    // 2. Connect and sync sheet
    const syncService = new WorkspaceSyncService();
    const syncedSheetId = await syncService.connectSheet(
      workspaceId,
      sheet_id,
      sheet_name || 'Imported Sheet',
      project_id,
      team_id
    );

    res.json({ success: true, syncedSheetId });
  } catch (error: any) {
    logger.error('Error in google-sync:', error);
    res.status(500).json({ error: error.message || 'Failed to sync Google Sheet' });
  }
});

/**
 * POST /api/organizations/:id/tasks/create-wbs-template
 * Create a new Google Sheet with WBS template structure
 */
router.post('/:id/tasks/create-wbs-template', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { team_id } = req.body;
    const userId = req.user!.id;

    // 1. Get workspace to find root folder (optional)
    const wsResult = await query(
      'SELECT root_folder_id FROM workspaces WHERE organization_id = $1 AND created_by = $2',
      [id, userId]
    );
    const folderId = wsResult.rows[0]?.root_folder_id || 'root';

    // 2. Create template
    const syncService = new WorkspaceSyncService();
    const result = await syncService.createWbsTemplate(userId, id, folderId, team_id);

    res.json(result);
  } catch (error: any) {
    logger.error('Error in create-wbs-template:', error);
    res.status(500).json({ error: error.message || 'Failed to create template sheet' });
  }
});

/**
 * POST /api/organizations/:id/tasks/bulk-import
 * Bulk-import tasks from CSV (admin/manager only)
 */
router.post('/:id/tasks/bulk-import', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { tasks, project_id } = req.body;
    const userId = req.user!.id;

    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: 'No tasks provided' });
    }

    // Check role - only admin and manager can import
    const memberCheck = await query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = $3',
      [id, userId, 'active']
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Access denied' });
    const userRole = memberCheck.rows[0].role;
    if (userRole === 'member') return res.status(403).json({ error: 'Members cannot import tasks' });

    // Get or create project
    let finalProjectId = project_id;
    if (!finalProjectId) {
      let projectResult = await query(
        'SELECT id FROM projects WHERE organization_id = $1 AND name = $2',
        [id, 'General Tasks']
      );
      if (projectResult.rows.length === 0) {
        const newProject = await query(
          `INSERT INTO projects (organization_id, name, description, status, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [id, 'General Tasks', 'Default project for organization tasks', 'active', userId]
        );
        finalProjectId = newProject.rows[0].id;
      } else {
        finalProjectId = projectResult.rows[0].id;
      }
    }

    // Map wbs_code → task ID for parent resolution
    const wbsToId: Record<string, string> = {};
    const errors: string[] = [];
    let created = 0;

    for (const t of tasks) {
      try {
        const { title, wbs_code, assignee_raw, start_date, due_date, status, priority, complexity_weight } = t;
        if (!title) continue;

        // Resolve parent_task_id from WBS
        let parentTaskId: string | null = null;
        if (wbs_code && wbs_code.includes('.')) {
          const parts = wbs_code.split('.');
          const parentWbs = parts.slice(0, -1).join('.');
          parentTaskId = wbsToId[parentWbs] || null;
        }

        // Parse date safely
        const parseDate = (d: string) => {
          if (!d) return null;
          const date = new Date(d);
          return isNaN(date.getTime()) ? null : date.toISOString().split('T')[0];
        };

        const taskResult = await query(
          `INSERT INTO tasks (
            project_id, title, status, priority, start_date, due_date,
            complexity_weight, wbs_code, parent_task_id, created_by,
            description
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          RETURNING id`,
          [
            finalProjectId, title, status || 'todo', priority || 'medium',
            parseDate(start_date), parseDate(due_date),
            complexity_weight || 1, wbs_code || null, parentTaskId,
            userId,
            assignee_raw ? `Assignee: ${assignee_raw}` : null
          ]
        );

        const newTaskId = taskResult.rows[0].id;
        if (wbs_code) wbsToId[wbs_code] = newTaskId;
        created++;
      } catch (taskErr: any) {
        errors.push(`Task "${t.title}": ${taskErr.message}`);
      }
    }

    logger.info(`Bulk import: ${created} tasks created in org ${id}`);
    res.status(201).json({ created, errors });
  } catch (error) {
    logger.error('Error in bulk import:', error);
    res.status(500).json({ error: 'Bulk import failed' });
  }
});

/**
 * PATCH /api/organizations/:orgId/members/:memberId/role
 * Update a member's role (Admin only)
 */
router.patch('/:orgId/members/:memberId/role', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { orgId, memberId } = req.params;
    const { role } = req.body;
    const userId = req.user!.id;

    if (!['admin', 'manager', 'member', 'adviser'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be admin, manager, member, or adviser' });
    }

    // Check if current user is admin
    const adminCheck = await query(
      `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`,
      [orgId, userId]
    );

    if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can change member roles' });
    }

    // Prevent demoting yourself if you're the only admin
    if (memberId === userId && role !== 'admin') {
      const adminCount = await query(
        `SELECT COUNT(*) FROM organization_members WHERE organization_id = $1 AND role = 'admin' AND status = 'active'`,
        [orgId]
      );
      if (parseInt(adminCount.rows[0].count) <= 1) {
        return res.status(400).json({ error: 'Cannot demote the only admin' });
      }
    }

    // Update role
    const result = await query(
      `UPDATE organization_members SET role = $1 WHERE organization_id = $2 AND user_id = $3 RETURNING *`,
      [role, orgId, memberId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // If the new role is 'adviser', sync to ss_account so ScholarSync recognises them
    if (role === 'adviser') {
      try {
        const memberUser = await query('SELECT name, email FROM users WHERE id = $1', [memberId]);
        const mu = memberUser.rows[0];
        if (mu?.email) {
          await query(
            `INSERT INTO ss_account ("accountName", "accountEmail", "accountRole")
             VALUES ($1, $2, 'Adviser')
             ON CONFLICT ("accountEmail") DO UPDATE SET "accountRole" = 'Adviser'`,
            [mu.name || '', mu.email]
          );
        }
      } catch (ssErr) {
        logger.warn('Could not upsert ss_account for adviser role change (table may not exist):', ssErr);
      }
    } else if (role === 'admin') {
      // Becoming an Admin in the project-management side immediately grants
      // ScholarSync (consultation) Admin status too — see ssAccountSync.service.ts
      const memberUser = await query('SELECT name, email FROM users WHERE id = $1', [memberId]);
      const mu = memberUser.rows[0];
      await syncScholarSyncAdminRole(mu?.email, mu?.name, memberId);
    }

    logger.info(`Role updated: user ${memberId} is now ${role} in org ${orgId}`);
    res.json({ success: true, role });
  } catch (error) {
    logger.error('Error updating member role:', error);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

/**
 * PATCH /api/organizations/:orgId/members/:memberId/academic-role
 * Set a member's ScholarSync academic role (Student / Adviser / Admin / External Leader)
 * directly from the org's Team → Role Management UI.
 *
 * This is intentionally a SEPARATE dimension from organization_members.role — per
 * migration 053 ("unify roles, remove overwrite trigger"), the org role and the
 * academic role are two independent systems that coexist for the same person and
 * must NOT cascade/overwrite one another (e.g. an org "manager" who is also an
 * academic "Student" should stay an org manager). This endpoint only ever touches
 * ss_account.accountRole — it never writes to organization_members.
 *
 * Auth: gated the SAME way as the org-role route above (caller must be an org admin),
 * NOT by verifyAdmin (which checks academic-admin status and would incorrectly 403
 * an org-admin who isn't also an academic Admin).
 */
router.patch('/:orgId/members/:memberId/academic-role', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { orgId, memberId } = req.params;
    const { academic_role } = req.body;
    const userId = req.user!.id;

    const VALID_ACADEMIC_ROLES = ['Student', 'Adviser', 'Admin', 'External Leader'];
    if (!VALID_ACADEMIC_ROLES.includes(academic_role)) {
      return res.status(400).json({ error: 'Invalid academic role. Must be Student, Adviser, Admin, or External Leader' });
    }

    // Check if current user is an org admin (same pattern as the org-role route)
    const adminCheck = await query(
      `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`,
      [orgId, userId]
    );

    if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can change academic roles' });
    }

    // Confirm the target is actually a member of this org
    const memberCheck = await query(
      `SELECT u.id, u.name, u.email FROM organization_members om
       INNER JOIN users u ON om.user_id = u.id
       WHERE om.organization_id = $1 AND om.user_id = $2`,
      [orgId, memberId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const member = memberCheck.rows[0];
    if (!member.email) {
      return res.status(400).json({ error: 'Member has no email on file — cannot link an academic account' });
    }

    // Upsert into ss_account — same pattern used for the adviser-role cascade above.
    // This links/creates the academic account by email and sets its role, independent
    // of (and without touching) the member's organization_members.role.
    await query(
      `INSERT INTO ss_account ("accountName", "accountEmail", "accountRole", user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("accountEmail") DO UPDATE SET "accountRole" = $3, user_id = COALESCE(ss_account.user_id, $4)`,
      [member.name || '', member.email, academic_role, memberId]
    );

    logger.info(`Academic role updated: user ${memberId} (${member.email}) is now academic "${academic_role}" — set by org admin ${userId} in org ${orgId}`);
    res.json({ success: true, academic_role });
  } catch (error) {
    logger.error('Error updating member academic role:', error);
    res.status(500).json({ error: 'Failed to update academic role' });
  }
});

/**
 * DELETE /api/organizations/:orgId/members/:memberId
 * Remove a member from organization (Admin only)
 */
router.delete('/:orgId/members/:memberId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { orgId, memberId } = req.params;
    const userId = req.user!.id;

    // Check if current user is admin
    const adminCheck = await query(
      `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`,
      [orgId, userId]
    );

    if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can remove members' });
    }

    // Prevent removing yourself if you're the only admin
    if (memberId === userId) {
      const adminCount = await query(
        `SELECT COUNT(*) FROM organization_members WHERE organization_id = $1 AND role = 'admin' AND status = 'active'`,
        [orgId]
      );
      if (parseInt(adminCount.rows[0].count) <= 1) {
        return res.status(400).json({ error: 'Cannot remove the only admin' });
      }
    }

    // Remove member
    await query(
      `DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
      [orgId, memberId]
    );

    logger.info(`Member ${memberId} removed from organization ${orgId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

/**
 * POST /api/organizations/:id/leave
 * Leave an organization (any member can leave)
 */
router.post('/:id/leave', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Check if user is a member
    const memberCheck = await query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = $3',
      [id, userId, 'active']
    );

    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ error: 'You are not a member of this organization' });
    }

    const userRole = memberCheck.rows[0].role;

    // If user is admin, check if they're the only admin
    if (userRole === 'admin') {
      const adminCount = await query(
        `SELECT COUNT(*) FROM organization_members WHERE organization_id = $1 AND role = 'admin' AND status = 'active'`,
        [id]
      );
      if (parseInt(adminCount.rows[0].count) <= 1) {
        // Check if there are other members who could become admin
        const memberCount = await query(
          `SELECT COUNT(*) FROM organization_members WHERE organization_id = $1 AND status = 'active'`,
          [id]
        );
        if (parseInt(memberCount.rows[0].count) > 1) {
          return res.status(400).json({
            error: 'You are the only admin. Please promote another member to admin before leaving, or delete the workspace.'
          });
        }
        // If only member, just delete the org
        await query('DELETE FROM organizations WHERE id = $1', [id]);
        logger.info(`Organization ${id} deleted as last admin left`);
        return res.json({ success: true, message: 'Workspace deleted as you were the only member' });
      }
    }

    // Remove user from organization
    await query(
      'DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [id, userId]
    );

    logger.info(`User ${userId} left organization ${id}`);
    res.json({ success: true, message: 'Successfully left the workspace' });
  } catch (error) {
    logger.error('Error leaving organization:', error);
    res.status(500).json({ error: 'Failed to leave organization' });
  }
});

/**
 * DELETE /api/organizations/:id
 * Delete an organization (admin only)
 */
router.delete('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Check if user is admin
    const roleCheck = await query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = $3',
      [id, userId, 'active']
    );

    if (roleCheck.rows.length === 0 || roleCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can delete workspaces' });
    }

    // Delete organization (cascade will handle members, projects, tasks)
    await query('DELETE FROM organizations WHERE id = $1', [id]);

    logger.info(`Organization ${id} deleted by user ${userId}`);
    res.json({ success: true, message: 'Workspace deleted successfully' });
  } catch (error) {
    logger.error('Error deleting organization:', error);
    res.status(500).json({ error: 'Failed to delete organization' });
  }
});

/**
 * GET /api/organizations/:id/teams
 * Get teams for an organization (filtered by user role)
 */
router.get('/:id/teams', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Check if user is member and get their role
    const memberCheck = await query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = $3',
      [id, userId, 'active']
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const userRole = memberCheck.rows[0].role;

    let teamsQuery = '';
    let params: any[] = [id];

    if (userRole === 'member') {
      // Students only see their own team(s)
      teamsQuery = `
        SELECT tg.*, 
               COUNT(tgm.id) as member_count
        FROM team_groups tg
        LEFT JOIN team_group_members tgm ON tg.id = tgm.team_group_id
        WHERE tg.organization_id = $1 
          AND EXISTS (
            SELECT 1 FROM team_group_members 
            WHERE team_group_id = tg.id AND user_id = $2
          )
        GROUP BY tg.id
        ORDER BY tg.team_number ASC
      `;
      params.push(userId);
    } else {
      // Admins and managers see all teams
      teamsQuery = `
        SELECT tg.*, 
               COUNT(tgm.id) as member_count
        FROM team_groups tg
        LEFT JOIN team_group_members tgm ON tg.id = tgm.team_group_id
        WHERE tg.organization_id = $1
        GROUP BY tg.id
        ORDER BY tg.team_number ASC
      `;
    }

    const result = await query(teamsQuery, params);

    res.json({ teams: result.rows, userRole });
  } catch (error) {
    logger.error('Error fetching teams:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

export default router;
