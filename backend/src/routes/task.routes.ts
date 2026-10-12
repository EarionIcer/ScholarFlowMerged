import { Router, Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth.middleware';
import { query, transaction } from '../config/database';
import logger from '../config/logger';
import notificationService from '../services/notification.service';
import { WorkspaceSyncService } from '../services/workspace.service';
import { sseService } from '../services/sse.service';

const router = Router();

/**
 * POST /api/tasks
 * Create a new task
 * Only admin and manager can create tasks
 */
router.post('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const {
      project_id,
      title,
      description,
      status,
      priority,
      due_date,
      start_date,
      estimated_hours,
      assigned_to,
      assigned_to_ids, // Array of user IDs
      is_absolute,
      complexity_weight,
      wbs_code,
      parent_task_id,
      luxury_weight,
      team_id
    } = req.body;
    const userId = req.user!.id;

    if (!project_id || !title) {
      return res.status(400).json({ error: 'Project ID and title are required' });
    }

    // Check if user has access to project AND get their role
    const accessCheck = await query(
      `SELECT pm.role as project_role, om.role as org_role
       FROM projects p
       INNER JOIN organization_members om ON p.organization_id = om.organization_id
       LEFT JOIN project_members pm ON p.id = pm.project_id AND pm.user_id = $2
       WHERE p.id = $1 AND om.user_id = $2 AND om.status = $3`,
      [project_id, userId, 'active']
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check role - only admin and manager can create tasks
    const userRole = accessCheck.rows[0].org_role;
    if (userRole === 'member') {
      return res.status(403).json({ error: 'Members cannot create tasks. Contact an admin or manager.' });
    }

    // Auto-generate WBS code if not provided
    let finalWbsCode = wbs_code;
    if (!finalWbsCode) {
      if (parent_task_id) {
        const parentResult = await query('SELECT wbs_code FROM tasks WHERE id = $1', [parent_task_id]);
        const parentWbs = parentResult.rows[0]?.wbs_code || '1';
        const countResult = await query(
          'SELECT COUNT(*) FROM tasks WHERE parent_task_id = $1 AND project_id = $2',
          [parent_task_id, project_id]
        );
        const siblingCount = parseInt(countResult.rows[0].count) + 1;
        finalWbsCode = `${parentWbs}.${siblingCount}`;
      } else {
        const countResult = await query(
          'SELECT COUNT(*) FROM tasks WHERE parent_task_id IS NULL AND project_id = $1',
          [project_id]
        );
        const rootCount = parseInt(countResult.rows[0].count) + 1;
        finalWbsCode = `${rootCount}`;
      }
    }

    // Create task
    const result = await query(
      `INSERT INTO tasks (
        project_id, title, description, status, priority,
        due_date, start_date, estimated_hours, assigned_to, 
        created_by, is_absolute, complexity_weight, wbs_code, parent_task_id, luxury_weight, team_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`,
      [
        project_id, title, description, status || 'todo', priority || 'medium',
        due_date, start_date, estimated_hours, assigned_to, userId,
        is_absolute || false, complexity_weight || 1, finalWbsCode, parent_task_id, luxury_weight || 1, team_id
      ]
    );

    const createdTask = result.rows[0];

    // If task has an assignee, send notification and add to task_assignees
    if (assigned_to && assigned_to !== userId) {
      // Get creator's name for notification
      const userResult = await query('SELECT name FROM users WHERE id = $1', [userId]);
      const creatorName = userResult.rows[0]?.name || 'Someone';

      // Send notification to assignee
      await notificationService.notifyTaskAssignment(
        createdTask.id,
        title,
        assigned_to,
        creatorName
      );

      // Add to task_assignees junction table
      await query(
        `INSERT INTO task_assignees (task_id, user_id, assigned_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [createdTask.id, assigned_to, userId]
      );

      // Auto-follow task for assignee
      await query(
        `INSERT INTO task_followers (task_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [createdTask.id, assigned_to]
      );

      logger.info(`Task ${createdTask.id} created and assigned to ${assigned_to}, notification sent`);
    }

    // Add additional assignees if provided
    if (assigned_to_ids && Array.isArray(assigned_to_ids)) {
      for (const assigneeId of assigned_to_ids) {
        if (assigneeId === assigned_to) continue; // Already added
        await query(
          `INSERT INTO task_assignees (task_id, user_id, assigned_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (task_id, user_id) DO NOTHING`,
          [createdTask.id, assigneeId, userId]
        );
      }
    }

    logger.info(`Task created: ${createdTask.id} by user ${userId}`);
    const projOrg = await query('SELECT organization_id FROM projects WHERE id = $1', [project_id]);
    if (projOrg.rows[0]) sseService.broadcastTaskUpdate(projOrg.rows[0].organization_id, createdTask, 'task_created');
    res.status(201).json(createdTask);
  } catch (error) {
    logger.error('Error creating task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

/**
 * POST /api/tasks/recycle
 * Recycle completed/archived tasks into a NEW (or existing) project assigned to a
 * NEW (or existing) team, cloned as fresh `todo` tasks. Admin/manager only. (Rev 4)
 *
 * Body: {
 *   organization_id: string,
 *   source_task_ids: string[],
 *   project: { id?: string } | { name: string, description?: string },
 *   team:    { id?: string } | { name: string, description?: string, members?: [...] }
 * }
 */
router.post('/recycle', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { organization_id, source_task_ids, project, team } = req.body;

    if (!organization_id || !Array.isArray(source_task_ids) || source_task_ids.length === 0) {
      return res.status(400).json({ error: 'organization_id and a non-empty source_task_ids[] are required' });
    }
    if (!project || (!project.id && !project.name)) {
      return res.status(400).json({ error: 'A target project (existing id or new name) is required' });
    }
    if (!team || (!team.id && !team.name)) {
      return res.status(400).json({ error: 'A target team (existing id or new name) is required' });
    }

    // Only admins and managers can recycle tasks / create projects & teams
    const roleCheck = await query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = $3',
      [organization_id, userId, 'active']
    );
    if (roleCheck.rows.length === 0 || !['admin', 'manager'].includes(roleCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Manager or admin access required' });
    }

    const result = await transaction(async (client: any) => {
      // 1. Load source tasks — must belong to this organization
      const srcRes = await client.query(
        `SELECT t.* FROM tasks t
         JOIN projects p ON t.project_id = p.id
         WHERE t.id = ANY($1::uuid[]) AND p.organization_id = $2`,
        [source_task_ids, organization_id]
      );
      const sourceTasks = srcRes.rows;
      if (sourceTasks.length === 0) {
        throw Object.assign(new Error('No matching source tasks found in this organization'), { statusCode: 404 });
      }

      // 2. Resolve or create the target project
      let projectRow;
      if (project.id) {
        const pRes = await client.query(
          'SELECT * FROM projects WHERE id = $1 AND organization_id = $2',
          [project.id, organization_id]
        );
        if (pRes.rows.length === 0) throw Object.assign(new Error('Target project not found in this organization'), { statusCode: 404 });
        projectRow = pRes.rows[0];
      } else {
        const pRes = await client.query(
          `INSERT INTO projects (organization_id, name, description, status, priority, created_by)
           VALUES ($1, $2, $3, 'planning', 'medium', $4) RETURNING *`,
          [organization_id, project.name, project.description || null, userId]
        );
        projectRow = pRes.rows[0];
        await client.query(
          `INSERT INTO project_members (project_id, user_id, role, assigned_by)
           VALUES ($1, $2, 'lead', $3) ON CONFLICT (project_id, user_id) DO NOTHING`,
          [projectRow.id, userId, userId]
        );
      }
      const projectId = projectRow.id;

      // 3. Resolve or create the target team, and link it to the project
      let teamRow;
      if (team.id) {
        const tRes = await client.query(
          'SELECT * FROM team_groups WHERE id = $1 AND organization_id = $2',
          [team.id, organization_id]
        );
        if (tRes.rows.length === 0) throw Object.assign(new Error('Target team not found in this organization'), { statusCode: 404 });
        teamRow = tRes.rows[0];
        await client.query('UPDATE team_groups SET project_id = $1, updated_at = NOW() WHERE id = $2', [projectId, team.id]);
        teamRow.project_id = projectId;
      } else {
        const numRes = await client.query(
          'SELECT COALESCE(MAX(team_number), 0) + 1 AS next FROM team_groups WHERE organization_id = $1',
          [organization_id]
        );
        const nextNumber = numRes.rows[0].next;
        const tRes = await client.query(
          `INSERT INTO team_groups (organization_id, team_number, name, description, project_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [organization_id, nextNumber, team.name, team.description || null, projectId, userId]
        );
        teamRow = tRes.rows[0];
        if (Array.isArray(team.members)) {
          let n = 1;
          for (const m of team.members) {
            if (!m || (!m.email && !m.name)) continue;
            await client.query(
              `INSERT INTO team_group_members (team_group_id, member_number, name, email, student_id, is_leader)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [teamRow.id, n, m.name || m.email, m.email || null, m.student_id || null, m.is_leader || (n === 1)]
            );
            n++;
          }
        }
      }
      const teamId = teamRow.id;

      // 4. Clone each source task into the target project/team as a fresh todo task.
      //    Assignees, dates, progress and completion are intentionally cleared;
      //    is_absolute is reset so the new team can freely manage the tasks.
      const rootCountRes = await client.query(
        'SELECT COUNT(*) FROM tasks WHERE parent_task_id IS NULL AND project_id = $1',
        [projectId]
      );
      let rootCount = parseInt(rootCountRes.rows[0].count, 10);
      const created: any[] = [];
      for (const src of sourceTasks) {
        rootCount += 1;
        const wbs = String(rootCount);
        const ins = await client.query(
          `INSERT INTO tasks (
             project_id, title, description, status, priority,
             created_by, is_absolute, complexity_weight, wbs_code, luxury_weight, team_id
           ) VALUES ($1, $2, $3, 'todo', $4, $5, false, $6, $7, $8, $9)
           RETURNING *`,
          [projectId, src.title, src.description, src.priority || 'medium', userId,
           src.complexity_weight || 1, wbs, src.luxury_weight || 1, teamId]
        );
        created.push(ins.rows[0]);
      }

      return { project: projectRow, team: teamRow, created_task_count: created.length, tasks: created };
    });

    logger.info(`Recycled ${result.created_task_count} task(s) into project ${result.project.id} / team ${result.team.id} by user ${userId}`);
    return res.status(201).json(result);
  } catch (error: any) {
    logger.error('Error recycling tasks:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Failed to recycle tasks' });
  }
});

/**
 * GET /api/tasks
 * Get tasks (filtered by project, assigned user, status, etc.)
 */
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { project_id, assigned_to, status, priority } = req.query;

    let queryText = `
      SELECT t.*, 
             p.name as project_name,
             u1.name as assigned_to_name,
             u2.name as created_by_name,
             (SELECT json_agg(json_build_object('user_id', ta.user_id, 'name', u.name))
              FROM task_assignees ta
              JOIN users u ON ta.user_id = u.id
              WHERE ta.task_id = t.id) as assignees
      FROM tasks t
      INNER JOIN projects p ON t.project_id = p.id
      INNER JOIN organization_members om ON p.organization_id = om.organization_id
      LEFT JOIN users u1 ON t.assigned_to = u1.id
      LEFT JOIN users u2 ON t.created_by = u2.id
      WHERE om.user_id = $1 AND om.status = 'active'
    `;

    const params: any[] = [userId];

    if (project_id) {
      queryText += ` AND t.project_id = $${params.length + 1}`;
      params.push(project_id);
    }

    if (assigned_to) {
      // Filter by tasks that have this user as an assignee in the junction table
      queryText += ` AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $${params.length + 1})`;
      params.push(assigned_to);
    }

    if (status) {
      queryText += ` AND t.status = $${params.length + 1}`;
      params.push(status);
    }

    if (priority) {
      queryText += ` AND t.priority = $${params.length + 1}`;
      params.push(priority);
    }

    queryText += ' ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC';

    const result = await query(queryText, params);

    // Fetch assignees for each task
    const taskIds = result.rows.map(t => t.id);
    if (taskIds.length > 0) {
      const assigneesResult = await query(
        `SELECT ta.task_id, ta.user_id, u.name, u.email, u.profile_picture
         FROM task_assignees ta
         JOIN users u ON ta.user_id = u.id
         WHERE ta.task_id = ANY($1)`,
        [taskIds]
      );

      // Group assignees by task_id
      const assigneesByTask: Record<string, any[]> = {};
      for (const a of assigneesResult.rows) {
        if (!assigneesByTask[a.task_id]) {
          assigneesByTask[a.task_id] = [];
        }
        assigneesByTask[a.task_id].push({
          user_id: a.user_id,
          name: a.name,
          email: a.email,
          profile_picture: a.profile_picture
        });
      }

      // Add assignees to each task
      for (const task of result.rows) {
        task.assignees = assigneesByTask[task.id] || [];
      }
    }

    res.json(result.rows);
  } catch (error) {
    logger.error('Error fetching tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

/**
 * GET /api/tasks/:id
 * Get task details
 */
router.get('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Check access
    const result = await query(
      `SELECT t.*,
              p.name as project_name,
              u1.name as assigned_to_name,
              u2.name as created_by_name,
              parent.title as parent_task_title,
              (SELECT json_agg(json_build_object('user_id', ta.user_id, 'name', u.name))
               FROM task_assignees ta
               JOIN users u ON ta.user_id = u.id
               WHERE ta.task_id = t.id) as assignees
       FROM tasks t
       INNER JOIN projects p ON t.project_id = p.id
       INNER JOIN organization_members om ON p.organization_id = om.organization_id
       LEFT JOIN users u1 ON t.assigned_to = u1.id
       LEFT JOIN users u2 ON t.created_by = u2.id
       LEFT JOIN tasks parent ON t.parent_task_id = parent.id
       WHERE t.id = $1 AND om.user_id = $2 AND om.status = $3`,
      [id, userId, 'active']
    );

    if (result.rows.length === 0) {
      // Fallback: try sheet_tasks (handles NULL workspace_id via project path)
      const sheetResult = await query(
        `SELECT st.*,
                COALESCE(w.organization_id, p2.organization_id) as organization_id,
                om.role as org_role,
                p2.name as project_name
         FROM sheet_tasks st
         INNER JOIN synced_sheets ss ON st.synced_sheet_id = ss.id
         LEFT JOIN workspaces w ON ss.workspace_id = w.id
         LEFT JOIN projects p2 ON ss.project_id = p2.id
         INNER JOIN organization_members om ON COALESCE(w.organization_id, p2.organization_id) = om.organization_id
         WHERE st.id = $1 AND om.user_id = $2 AND om.status = $3`,
        [id, userId, 'active']
      );

      if (sheetResult.rows.length === 0) {
        return res.status(404).json({ error: 'Task not found or access denied' });
      }

      const sheetComments = await query(
        `SELECT tc.*, u.name as user_name, u.profile_picture
         FROM task_comments tc
         LEFT JOIN users u ON tc.user_id = u.id
         WHERE tc.task_id = $1
         ORDER BY tc.created_at DESC`,
        [id]
      );

      const sheetAssignees = await query(
        `SELECT ta.user_id, u.name, u.email, u.profile_picture, ta.assigned_at
         FROM task_assignees ta
         JOIN users u ON ta.user_id = u.id
         WHERE ta.task_id = $1
         ORDER BY ta.assigned_at ASC`,
        [id]
      );

      return res.json({
        ...sheetResult.rows[0],
        subtasks: [],
        comments: sheetComments.rows,
        assignees: sheetAssignees.rows,
      });
    }

    // Get subtasks
    const subtasks = await query(
      'SELECT id, title, status, priority FROM tasks WHERE parent_task_id = $1',
      [id]
    );

    // Get comments
    const comments = await query(
      `SELECT tc.*, u.name as user_name, u.profile_picture
       FROM task_comments tc
       LEFT JOIN users u ON tc.user_id = u.id
       WHERE tc.task_id = $1
       ORDER BY tc.created_at DESC`,
      [id]
    );

    // Get assignees from junction table
    const assigneesResult = await query(
      `SELECT ta.user_id, u.name, u.email, u.profile_picture, ta.assigned_at
       FROM task_assignees ta
       JOIN users u ON ta.user_id = u.id
       WHERE ta.task_id = $1
       ORDER BY ta.assigned_at ASC`,
      [id]
    );

    const task = {
      ...result.rows[0],
      subtasks: subtasks.rows,
      comments: comments.rows,
      assignees: assigneesResult.rows,
    };

    res.json(task);
  } catch (error) {
    logger.error('Error fetching task:', error);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

/**
 * PUT /api/tasks/:id
 * Update task
 * Only admin and manager can update tasks (members can only change status via drag)
 */
router.put('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const {
      title,
      description,
      status,
      priority,
      due_date,
      start_date,
      estimated_hours,
      actual_hours,
      assigned_to,
      assigned_to_ids, // Array of assignee IDs
      is_absolute,
      complexity_weight,
      wbs_code,
      parent_task_id,
      luxury_weight,
      progress_percent,
      team_id
    } = req.body;

    // Check access AND get role
    const accessCheck = await query(
      `SELECT om.role as org_role FROM tasks t
       INNER JOIN projects p ON t.project_id = p.id
       INNER JOIN organization_members om ON p.organization_id = om.organization_id
       WHERE t.id = $1 AND om.user_id = $2 AND om.status = $3`,
      [id, userId, 'active']
    );

    if (accessCheck.rows.length === 0) {
      // Fallback: check sheet_tasks (handles NULL workspace_id via project path)
      const sheetAccessCheck = await query(
        `SELECT st.*, COALESCE(w.organization_id, p2.organization_id) as organization_id, om.role as org_role FROM sheet_tasks st
         INNER JOIN synced_sheets ss ON st.synced_sheet_id = ss.id
         LEFT JOIN workspaces w ON ss.workspace_id = w.id
         LEFT JOIN projects p2 ON ss.project_id = p2.id
         INNER JOIN organization_members om ON COALESCE(w.organization_id, p2.organization_id) = om.organization_id
         WHERE st.id = $1 AND om.user_id = $2 AND om.status = $3`,
        [id, userId, 'active']
      );

      if (sheetAccessCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const oldSheetTask = sheetAccessCheck.rows[0];
      const sheetUserRole = oldSheetTask.org_role;

      if (sheetUserRole === 'member') {
        const allowedFields = ['status', 'progress_percent'];
        const updateFields = Object.keys(req.body);
        const isOnlyAllowedFields = updateFields.every(f => allowedFields.includes(f));
        if (!isOnlyAllowedFields) {
          return res.status(403).json({ error: 'Members can only update task status and progress.' });
        }
      }

      const sheetResult = await query(
        `UPDATE sheet_tasks
         SET title = COALESCE($1, title),
             description = COALESCE($2, description),
             priority = COALESCE($3, priority),
             due_date = COALESCE($4, due_date),
             is_absolute = COALESCE($5, is_absolute),
             wbs_code = COALESCE($6, wbs_code),
             complexity_weight = COALESCE($7, complexity_weight),
             synced_at = NOW()
         WHERE id = $8
         RETURNING *`,
        [title, description, priority, due_date, is_absolute, wbs_code, complexity_weight, id]
      );

      // Sync assignees to task_assignees table (same logic as regular tasks)
      if (assigned_to_ids && Array.isArray(assigned_to_ids)) {
        if (assigned_to_ids.length === 0) {
          await query(`DELETE FROM task_assignees WHERE task_id = $1`, [id]);
        } else {
          await query(
            `DELETE FROM task_assignees WHERE task_id = $1 AND user_id != ALL($2::uuid[])`,
            [id, assigned_to_ids]
          );
          for (const assigneeId of assigned_to_ids) {
            if (!assigneeId) continue;
            await query(
              `INSERT INTO task_assignees (task_id, user_id, assigned_by)
               VALUES ($1, $2, $3)
               ON CONFLICT (task_id, user_id) DO NOTHING`,
              [id, assigneeId, userId]
            );
          }
        }
      }

      const syncSvc = new WorkspaceSyncService();
      for (const [field, value] of Object.entries({ title, description, priority, due_date })) {
        if (value !== undefined && value !== null) {
          try { await syncSvc.updateSheetTask(id, field as any, value); } catch (e: any) {
            logger.warn(`PUT sheet sync failed for ${field}: ${e.message}`);
          }
        }
      }
      await syncSvc.calculateParentProgress(id);

      logger.info(`Sheet task ${id} updated via PUT by user ${userId}`);
      return res.json(sheetResult.rows[0]);
    }

    // Check if task is absolute
    const taskData = await query('SELECT is_absolute FROM tasks WHERE id = $1', [id]);
    const currentIsAbsolute = taskData.rows[0]?.is_absolute;

    // Check role - only admin and manager can update most fields
    const userRole = accessCheck.rows[0].org_role;
    
    // Students can only update status and progress_percent
    if (userRole === 'member') {
        const allowedFields = ['status', 'progress_percent'];
        const updateFields = Object.keys(req.body);
        const isOnlyAllowedFields = updateFields.every(f => allowedFields.includes(f));
        
        if (!isOnlyAllowedFields) {
            return res.status(403).json({ error: 'Members can only update task status and progress.' });
        }
    }

    // Update completed_at if status changed to completed
    const completedAt = status === 'completed' ? 'NOW()' : 'completed_at';

    const result = await query(
      `UPDATE tasks
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           priority = COALESCE($4, priority),
           due_date = COALESCE($5, due_date),
           start_date = COALESCE($6, start_date),
           estimated_hours = COALESCE($7, estimated_hours),
           actual_hours = COALESCE($8, actual_hours),
           assigned_to = COALESCE($9, assigned_to),
           is_absolute = COALESCE($10, is_absolute),
           complexity_weight = COALESCE($11, complexity_weight),
           wbs_code = COALESCE($12, wbs_code),
           parent_task_id = COALESCE($13, parent_task_id),
           luxury_weight = COALESCE($14, luxury_weight),
           progress_percent = COALESCE($15, progress_percent),
           completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE completed_at END
       WHERE id = $16
       RETURNING *`,
      [title, description, status, priority, due_date, start_date, estimated_hours, actual_hours, assigned_to, is_absolute, complexity_weight, wbs_code, parent_task_id, luxury_weight, progress_percent, id]
    );

    // Sync assignees if an explicit list is provided (sent by the edit modal)
    if (assigned_to_ids && Array.isArray(assigned_to_ids)) {
      // Remove all existing assignees that are not in the new list
      if (assigned_to_ids.length === 0) {
        await query(`DELETE FROM task_assignees WHERE task_id = $1`, [id]);
      } else {
        await query(
          `DELETE FROM task_assignees WHERE task_id = $1 AND user_id != ALL($2::uuid[])`,
          [id, assigned_to_ids]
        );
      }

      // Upsert new assignees
      for (const assigneeId of assigned_to_ids) {
        if (!assigneeId) continue;
        await query(
          `INSERT INTO task_assignees (task_id, user_id, assigned_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (task_id, user_id) DO NOTHING`,
          [id, assigneeId, userId]
        );
      }
    }
    // Note: individual add/remove is handled by POST/DELETE /api/tasks/:id/assignees endpoints

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

/**
 * DELETE /api/tasks/:id
 * Delete a task (regular or synced)
 */
router.delete('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // 1. Check if it's a regular task first
    const taskCheck = await query(
      `SELECT t.id, t.project_id FROM tasks t
       INNER JOIN projects p ON t.project_id = p.id
       INNER JOIN organization_members om ON p.organization_id = om.organization_id
       WHERE t.id = $1 AND om.user_id = $2 AND om.status = 'active'`,
      [id, userId]
    );

    if (taskCheck.rows.length > 0) {
      // Get org_id before deleting for SSE broadcast
      const projOrg = await query('SELECT organization_id FROM projects WHERE id = $1', [taskCheck.rows[0].project_id]);
      await query('DELETE FROM tasks WHERE id = $1', [id]);
      logger.info(`Regular task ${id} deleted by user ${userId}`);
      if (projOrg.rows[0]) sseService.broadcastTaskUpdate(projOrg.rows[0].organization_id, { id }, 'task_deleted');
      return res.json({ success: true, message: 'Task deleted' });
    }

    // 2. Check if it's a sheet task
    const sheetTaskCheck = await query(
      `SELECT st.id, st.sheet_row_index, ss.sheet_id, ss.id as synced_sheet_id, st.is_absolute, om.role as org_role
       FROM sheet_tasks st
       INNER JOIN synced_sheets ss ON st.synced_sheet_id = ss.id
       INNER JOIN workspaces w ON ss.workspace_id = w.id
       INNER JOIN organization_members om ON w.organization_id = om.organization_id
       WHERE st.id = $1 AND om.user_id = $2 AND om.status = 'active'`,
      [id, userId]
    );

    if (sheetTaskCheck.rows.length > 0) {
      const taskDetail = sheetTaskCheck.rows[0];

      // Check permissions for absolute tasks
      if (taskDetail.is_absolute && taskDetail.org_role === 'member') {
        return res.status(403).json({ error: 'This is a synced WBS task and can only be deleted by advisors.' });
      }

      // Optional: Delete from Google Sheet if possible
      // For now, we delete it from DB. SkyFlow is a "fortress", 
      // but students can delete tasks they created if they aren't absolute.
      // However, usually synced tasks should be deleted from the sheet.
      // We will allow deletion from DB to keep UI clean if they have permission.
      
      await query('DELETE FROM sheet_tasks WHERE id = $1', [id]);
      logger.info(`Sheet task ${id} deleted from DB by user ${userId}`);
      
      return res.json({ success: true, message: 'Synced task removed from SkyFlow view' });
    }

    return res.status(404).json({ error: 'Task not found or access denied' });
  } catch (error) {
    logger.error('Error deleting task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

/**
 * PATCH /api/tasks/:id/status
 * Update task status (for kanban drag-and-drop)
 * Supports both regular tasks and sheet_tasks
 */
router.patch('/:id/status', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;
  const userId = req.user!.id;

  try {

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    logger.info(`Status update request: Task ${id}, Status: ${status}, User: ${userId}`);

    // Map frontend status values to database values
    const statusMap: Record<string, string> = {
      'todo': 'todo',
      'in-progress': 'in_progress',
      'in_progress': 'in_progress',
      'review': 'review',
      'done': 'completed',
      'completed': 'completed',
      'archived': 'archived'
    };

    const sheetStatusMap: Record<string, string> = {
      'todo': 'todo',
      'in-progress': 'in-progress',
      'in_progress': 'in-progress',
      'review': 'review',
      'done': 'done',
      'completed': 'done',
      'archived': 'archived'
    };

    const dbStatus = statusMap[status] || status;
    const sheetDbStatus = sheetStatusMap[status] || status;

    // First, try to find in regular tasks table and check role
    const regularTaskCheck = await query(
      `SELECT t.id, t.is_absolute, p.organization_id, om.role as org_role FROM tasks t
       INNER JOIN projects p ON t.project_id = p.id
       INNER JOIN organization_members om ON p.organization_id = om.organization_id
       WHERE t.id = $1 AND om.user_id = $2 AND om.status = $3`,
      [id, userId, 'active']
    );

    if (regularTaskCheck.rows.length > 0) {
      const { is_absolute, org_role } = regularTaskCheck.rows[0];

      // Update regular task
      const result = await query(
        `UPDATE tasks
         SET status = $1::text,
             completed_at = CASE WHEN $1::text IN ('done', 'completed') THEN NOW() ELSE completed_at END,
             updated_at = NOW()
         WHERE id = $2::uuid
         RETURNING *`,
        [dbStatus, id]
      );

      // 2. Log activity
      await query(
        `INSERT INTO activity_log (organization_id, user_id, entity_id, entity_type, action, details, created_at)
         VALUES ($1, $2, $3, 'task', 'status_changed', $4, NOW())`,
        [regularTaskCheck.rows[0].organization_id, userId, id, JSON.stringify({ new_status: dbStatus })]
      );

      logger.info(`Task ${id} status updated to ${dbStatus} by user ${userId}`);
      sseService.broadcastTaskUpdate(regularTaskCheck.rows[0].organization_id, result.rows[0], 'task_updated');
      return res.json(result.rows[0]);
    }

    // If not found in tasks, try sheet_tasks
    const sheetTaskCheck = await query(
      `SELECT st.id, st.is_absolute, COALESCE(w.organization_id, p.organization_id) as organization_id, om.role as org_role FROM sheet_tasks st
       INNER JOIN synced_sheets ss ON st.synced_sheet_id = ss.id
       LEFT JOIN workspaces w ON ss.workspace_id = w.id
       LEFT JOIN projects p ON ss.project_id = p.id
       INNER JOIN organization_members om ON COALESCE(w.organization_id, p.organization_id) = om.organization_id
       WHERE st.id = $1 AND om.user_id = $2 AND om.status = $3`,
      [id, userId, 'active']
    );

    if (sheetTaskCheck.rows.length > 0) {
      const { is_absolute, org_role } = sheetTaskCheck.rows[0];

      // Check if this is an absolute (locked) task and user is a member
      // Update sheet_task in DB
      const result = await query(
        `UPDATE sheet_tasks
         SET status = $1::text,
             synced_at = NOW(),
             updated_at = NOW()
         WHERE id = $2::uuid
         RETURNING *`,
        [sheetDbStatus, id]
      );

        // 2. Write status back to Google Sheet (two-way sync) — fire-and-forget
        // Do NOT await; respond to client immediately. Background sync avoids
        // blocking the drag UX on Google Sheets API latency (~1-3s).
        (async () => {
          try {
            const workspaceSyncService = new WorkspaceSyncService();
            const writebackResult = await workspaceSyncService.updateSheetTask(id, 'status', sheetDbStatus);
            if (writebackResult.success) {
              logger.info(`Sheet task ${id} status written back to Google Sheet (background)`);
              await workspaceSyncService.calculateParentProgress(id);
            } else {
              logger.warn(`Sheet writeback failed for task ${id}: ${writebackResult.error}`);
            }
          } catch (writebackErr: any) {
            logger.warn(`Sheet writeback error for task ${id}: ${writebackErr.message}`);
          }
        })();

      // 3. Log activity
      await query(
        `INSERT INTO activity_log (organization_id, user_id, entity_id, entity_type, action, details, created_at)
         VALUES ($1, $2, $3, 'task', 'status_changed', $4, NOW())`,
        [sheetTaskCheck.rows[0].organization_id, userId, id, JSON.stringify({ new_status: sheetDbStatus })]
      );

      logger.info(`Sheet task ${id} status updated to ${dbStatus} by user ${userId}`);
      return res.json(result.rows[0]);
    }

    // Task not found in either table or no access
    logger.warn(`Access denied or task not found for ID: ${id}, User: ${userId}`);
    return res.status(403).json({ 
      error: 'Access denied or task not found',
      debug: { id, userId, regularRows: regularTaskCheck.rows.length }
    });

  } catch (error: any) {
    logger.error(`Error updating task status for ${id}:`, error);
    res.status(500).json({ 
      error: 'Failed to update task status', 
      details: error.message,
      code: error.code,
      stack: error.stack
    });
  }
});

/**
 * PATCH /api/tasks/:id
 * Update task fields (assignment, title, description, etc.)
 * Only admin and manager can edit tasks (members can only change status via /status endpoint)
 */
router.patch('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description, priority, due_date, status, progress_percent } = req.body;
    const userId = req.user!.id;
    const userName = req.user!.name;

    // Check if status or progress_percent was explicitly provided
    const statusProvided = 'status' in req.body;
    const progressProvided = 'progress_percent' in req.body;

    // Check if assigned_to was explicitly provided (even if null)
    const assignedToProvided = 'assigned_to' in req.body;
    const assigned_to = req.body.assigned_to;

    // 1. Try finding in regular tasks Table
    const regularTaskCheck = await query(
      `SELECT t.*, om.role as org_role FROM tasks t
       INNER JOIN projects p ON t.project_id = p.id
       INNER JOIN organization_members om ON p.organization_id = om.organization_id
       WHERE t.id = $1 AND om.user_id = $2 AND om.status = $3`,
      [id, userId, 'active']
    );

    if (regularTaskCheck.rows.length > 0) {
      const oldTask = regularTaskCheck.rows[0];
      const userRole = oldTask.org_role;

      // Check role - only admin and manager can edit all fields
      if (userRole === 'member') {
        const allowedFields = ['status', 'progress_percent'];
        const updateFields = Object.keys(req.body);
        const isOnlyAllowedFields = updateFields.every(f => allowedFields.includes(f));
        
        if (!isOnlyAllowedFields) {
          return res.status(403).json({ error: 'Members can only update task status and progress.' });
        }
      }

      const result = await query(
        `UPDATE tasks
         SET assigned_to = CASE WHEN $1 THEN $2 ELSE assigned_to END,
             title = COALESCE($3, title),
             description = COALESCE($4, description),
             priority = COALESCE($5, priority),
             due_date = COALESCE($6, due_date),
             status = CASE WHEN $7 THEN $8 ELSE status END,
             progress_percent = CASE WHEN $9 THEN $10 ELSE progress_percent END,
             completed_at = CASE WHEN $8 IN ('done', 'completed') THEN NOW() ELSE completed_at END
         WHERE id = $11
         RETURNING *`,
        [assignedToProvided, assigned_to, title, description, priority, due_date, statusProvided, status, progressProvided, progress_percent, id]
      );

      const updatedTask = result.rows[0];

      // Assignment change logic
      if (assigned_to && assigned_to !== oldTask.assigned_to) {
        await notificationService.notifyTaskAssignment(id, updatedTask.title, assigned_to, userName || 'Someone');
        await query(`INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2) ON CONFLICT (task_id, user_id) DO NOTHING`, [id, assigned_to]);
      }

      const orgRow = await query('SELECT p.organization_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = $1', [id]);
      if (orgRow.rows[0]) sseService.broadcastTaskUpdate(orgRow.rows[0].organization_id, updatedTask, 'task_updated');
      logger.info(`Regular task ${id} updated by user ${userId}`);
      return res.json(updatedTask);
    }

    // 2. Try finding in sheet_tasks Table
    const sheetTaskCheck = await query(
      `SELECT st.*, COALESCE(w.organization_id, p.organization_id) as organization_id, om.role as org_role, ss.workspace_id FROM sheet_tasks st
       INNER JOIN synced_sheets ss ON st.synced_sheet_id = ss.id
       LEFT JOIN workspaces w ON ss.workspace_id = w.id
       LEFT JOIN projects p ON ss.project_id = p.id
       INNER JOIN organization_members om ON COALESCE(w.organization_id, p.organization_id) = om.organization_id
       WHERE st.id = $1 AND om.user_id = $2 AND om.status = $3`,
      [id, userId, 'active']
    );

    if (sheetTaskCheck.rows.length > 0) {
      const oldTask = sheetTaskCheck.rows[0];
      const userRole = oldTask.org_role;

      // Check if task is absolute and user is member
      if (oldTask.is_absolute && userRole === 'member') {
        return res.status(403).json({ error: 'This is a synced WBS task and cannot be modified by students.' });
      }

      // Update sheet_tasks in DB
      const result = await query(
        `UPDATE sheet_tasks
         SET title = COALESCE($1, title),
             description = COALESCE($2, description),
             priority = COALESCE($3, priority),
             due_date = COALESCE($4, due_date),
             status = CASE WHEN $5 THEN $6 ELSE status END,
             progress_percent = CASE WHEN $7 THEN $8 ELSE progress_percent END,
             luxury_weight = COALESCE($9, luxury_weight),
             synced_at = NOW()
         WHERE id = $10
         RETURNING *`,
        [title, description, priority, due_date, statusProvided, status, progressProvided, progress_percent, req.body.luxury_weight, id]
      );

      const updatedTask = result.rows[0];

      // Two-way Sync back to Google Sheets
      const syncService = new WorkspaceSyncService();
      const fieldsToSync = [];
      if (title) fieldsToSync.push({ field: 'title', value: title });
      if (description) fieldsToSync.push({ field: 'description', value: description });
      if (priority) fieldsToSync.push({ field: 'priority', value: priority });
      if (due_date) fieldsToSync.push({ field: 'due_date', value: due_date });
      if (statusProvided) fieldsToSync.push({ field: 'status', value: status });
      if (progressProvided) fieldsToSync.push({ field: 'progress_percent', value: progress_percent });

      for (const f of fieldsToSync) {
        try {
          await syncService.updateSheetTask(id, f.field as any, f.value);
        } catch (err: any) {
          logger.warn(`Failed to sync ${f.field} for sheet task ${id}: ${err.message}`);
        }
      }

      // Trigger hierarchical progress calculation if status-affecting fields changed (currently just updating fields)
      // Actually, any field update might eventually affect progress if we add weights etc.
      await syncService.calculateParentProgress(id);

      logger.info(`Sheet task ${id} updated by user ${userId} and synced back`);
      return res.json(updatedTask);
    }

    return res.status(404).json({ error: 'Task not found or access denied' });
  } catch (error: any) {
    logger.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

/**
 * POST /api/tasks/:id/comments
 * Add comment to task
 */
router.post('/:id/comments', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { comment } = req.body;
    const userId = req.user!.id;
    const userName = req.user!.name;

    if (!comment) {
      return res.status(400).json({ error: 'Comment is required' });
    }

    // Check access and get task info
    const taskCheck = await query(
      `SELECT t.title FROM tasks t
       INNER JOIN projects p ON t.project_id = p.id
       INNER JOIN organization_members om ON p.organization_id = om.organization_id
       WHERE t.id = $1 AND om.user_id = $2 AND om.status = $3`,
      [id, userId, 'active']
    );

    if (taskCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const taskTitle = taskCheck.rows[0].title;

    const insertResult = await query(
      'INSERT INTO task_comments (task_id, user_id, comment) VALUES ($1, $2, $3) RETURNING id',
      [id, userId, comment]
    );

    // Re-fetch with user info so frontend gets user_name immediately
    const result = await query(
      `SELECT c.id, c.task_id, c.user_id, c.comment, c.created_at, c.updated_at,
              u.name as user_name, u.email as user_email
       FROM task_comments c
       LEFT JOIN users u ON c.user_id = u.id
       WHERE c.id = $1`,
      [insertResult.rows[0].id]
    );

    // Auto-follow commenter (if not already following)
    await query(
      `INSERT INTO task_followers (task_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (task_id, user_id) DO NOTHING`,
      [id, userId]
    );

    // Notify all followers except the commenter
    const followers = await query(
      `SELECT user_id FROM task_followers WHERE task_id = $1 AND user_id != $2`,
      [id, userId]
    );

    for (const follower of followers.rows) {
      await notificationService.notifyNewComment(id, taskTitle, follower.user_id, userName || 'Someone');
    }

    res.status(201).json({ comment: result.rows[0] });
  } catch (error) {
    logger.error('Error adding comment:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

/**
 * POST /api/tasks/:id/time
 * Log time entry for task
 */
router.post('/:id/time', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { start_time, end_time, duration_minutes, description } = req.body;
    const userId = req.user!.id;

    // Check access
    const accessCheck = await query(
      `SELECT 1 FROM tasks t
       INNER JOIN projects p ON t.project_id = p.id
       INNER JOIN organization_members om ON p.organization_id = om.organization_id
       WHERE t.id = $1 AND om.user_id = $2 AND om.status = $3`,
      [id, userId, 'active']
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await query(
      `INSERT INTO time_entries (task_id, user_id, start_time, end_time, duration_minutes, description)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, userId, start_time, end_time, duration_minutes, description]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Error logging time:', error);
    res.status(500).json({ error: 'Failed to log time' });
  }
});

/**
 * POST /api/tasks/:id/follow
 * Follow a task to receive comment notifications
 */
router.post('/:id/follow', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Check access to task
    const accessCheck = await query(
      `SELECT 1 FROM tasks t
       INNER JOIN projects p ON t.project_id = p.id
       INNER JOIN organization_members om ON p.organization_id = om.organization_id
       WHERE t.id = $1 AND om.user_id = $2 AND om.status = $3`,
      [id, userId, 'active']
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Insert or ignore if already following
    await query(
      `INSERT INTO task_followers (task_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (task_id, user_id) DO NOTHING`,
      [id, userId]
    );

    res.json({ following: true });
  } catch (error) {
    logger.error('Error following task:', error);
    res.status(500).json({ error: 'Failed to follow task' });
  }
});

/**
 * DELETE /api/tasks/:id/follow
 * Unfollow a task to stop receiving comment notifications
 */
router.delete('/:id/follow', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    await query(
      `DELETE FROM task_followers WHERE task_id = $1 AND user_id = $2`,
      [id, userId]
    );

    res.json({ following: false });
  } catch (error) {
    logger.error('Error unfollowing task:', error);
    res.status(500).json({ error: 'Failed to unfollow task' });
  }
});

/**
 * GET /api/tasks/:id/following
 * Check if current user is following a task
 */
router.get('/:id/following', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const result = await query(
      `SELECT 1 FROM task_followers WHERE task_id = $1 AND user_id = $2`,
      [id, userId]
    );

    res.json({ following: result.rows.length > 0 });
  } catch (error) {
    logger.error('Error checking follow status:', error);
    res.status(500).json({ error: 'Failed to check follow status' });
  }
});

/**
 * GET /api/tasks/:id/activity
 * Returns task details + activity log + comments — used by TaskTimeline component
 */
router.get('/:id/activity', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    // Try regular tasks first
    let taskResult = await query(
      `SELECT t.*, p.name as project_name, u.name as assigned_to_name
       FROM tasks t
       INNER JOIN projects p ON t.project_id = p.id
       INNER JOIN organization_members om ON p.organization_id = om.organization_id
       LEFT JOIN users u ON t.assigned_to = u.id
       WHERE t.id = $1 AND om.user_id = $2 AND om.status = 'active'`,
      [id, userId]
    );

    // Fallback: sheet_tasks
    if (taskResult.rows.length === 0) {
      taskResult = await query(
        `SELECT st.*, COALESCE(w.organization_id, p2.organization_id) as organization_id
         FROM sheet_tasks st
         INNER JOIN synced_sheets ss ON st.synced_sheet_id = ss.id
         LEFT JOIN workspaces w ON ss.workspace_id = w.id
         LEFT JOIN projects p2 ON ss.project_id = p2.id
         INNER JOIN organization_members om ON COALESCE(w.organization_id, p2.organization_id) = om.organization_id
         WHERE st.id = $1 AND om.user_id = $2 AND om.status = 'active'`,
        [id, userId]
      );
    }

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found or access denied' });
    }

    const task = taskResult.rows[0];

    // Activity log (best-effort — returns [] if table missing the row)
    const activityResult = await query(
      `SELECT al.*, u.name as user_name
       FROM activity_log al
       LEFT JOIN users u ON al.user_id = u.id
       WHERE al.entity_id = $1
       ORDER BY al.created_at ASC`,
      [id]
    ).catch(() => ({ rows: [] }));

    // Comments
    const commentsResult = await query(
      `SELECT tc.*, u.name as user_name, u.profile_picture
       FROM task_comments tc
       LEFT JOIN users u ON tc.user_id = u.id
       WHERE tc.task_id = $1
       ORDER BY tc.created_at ASC`,
      [id]
    );

    return res.json({
      task,
      activities: activityResult.rows,
      comments: commentsResult.rows,
    });
  } catch (error) {
    logger.error('Error fetching task activity:', error);
    res.status(500).json({ error: 'Failed to fetch task activity' });
  }
});

/**
 * GET /api/tasks/:id/assignees
 * Get all assignees for a task
 */
router.get('/:id/assignees', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT ta.user_id, u.name, u.email, u.profile_picture, ta.assigned_at
       FROM task_assignees ta
       JOIN users u ON ta.user_id = u.id
       WHERE ta.task_id = $1
       ORDER BY ta.assigned_at ASC`,
      [id]
    );

    res.json(result.rows);
  } catch (error) {
    logger.error('Error fetching assignees:', error);
    res.status(500).json({ error: 'Failed to fetch assignees' });
  }
});

/**
 * POST /api/tasks/:id/assignees
 * Add assignees to a task (admin/manager only)
 */
router.post('/:id/assignees', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { user_ids } = req.body; // Array of user IDs to add
    const userId = req.user!.id;
    const userName = req.user!.name;

    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ error: 'user_ids array is required' });
    }

    // Check if user is admin or manager in the organization
    let roleCheck = await query(
      `SELECT om.role, t.title FROM tasks t
       INNER JOIN projects p ON t.project_id = p.id
       INNER JOIN organization_members om ON p.organization_id = om.organization_id
       WHERE t.id = $1 AND om.user_id = $2 AND om.status = 'active'`,
      [id, userId]
    );

    if (roleCheck.rows.length === 0) {
      // Fallback: check sheet_tasks
      roleCheck = await query(
        `SELECT om.role, st.title FROM sheet_tasks st
         INNER JOIN synced_sheets ss ON st.synced_sheet_id = ss.id
         LEFT JOIN workspaces w ON ss.workspace_id = w.id
         LEFT JOIN projects p2 ON ss.project_id = p2.id
         INNER JOIN organization_members om ON COALESCE(w.organization_id, p2.organization_id) = om.organization_id
         WHERE st.id = $1 AND om.user_id = $2 AND om.status = 'active'`,
        [id, userId]
      );
    }

    if (roleCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const role = roleCheck.rows[0].role;
    const taskTitle = roleCheck.rows[0].title;

    if (role !== 'admin' && role !== 'manager') {
      return res.status(403).json({ error: 'Only admins and managers can modify assignees' });
    }

    // Add each assignee
    for (const assigneeId of user_ids) {
      await query(
        `INSERT INTO task_assignees (task_id, user_id, assigned_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [id, assigneeId, userId]
      );

      // Send notification to new assignee (if not self)
      if (assigneeId !== userId) {
        await notificationService.notifyTaskAssignment(id, taskTitle, assigneeId, userName || 'Someone');
      }

      // Auto-follow task for new assignee
      await query(
        `INSERT INTO task_followers (task_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [id, assigneeId]
      );
    }

    // Return updated assignees list
    const result = await query(
      `SELECT ta.user_id, u.name, u.email, u.profile_picture, ta.assigned_at
       FROM task_assignees ta
       JOIN users u ON ta.user_id = u.id
       WHERE ta.task_id = $1
       ORDER BY ta.assigned_at ASC`,
      [id]
    );

    res.json(result.rows);
  } catch (error) {
    logger.error('Error adding assignees:', error);
    res.status(500).json({ error: 'Failed to add assignees' });
  }
});

/**
 * DELETE /api/tasks/:id/assignees/:userId
 * Remove an assignee from a task (admin/manager only)
 */
router.delete('/:id/assignees/:assigneeId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id, assigneeId } = req.params;
    const userId = req.user!.id;

    // Check if user is admin or manager in the organization
    let roleCheck = await query(
      `SELECT om.role FROM tasks t
       INNER JOIN projects p ON t.project_id = p.id
       INNER JOIN organization_members om ON p.organization_id = om.organization_id
       WHERE t.id = $1 AND om.user_id = $2 AND om.status = 'active'`,
      [id, userId]
    );

    if (roleCheck.rows.length === 0) {
      roleCheck = await query(
        `SELECT om.role FROM sheet_tasks st
         INNER JOIN synced_sheets ss ON st.synced_sheet_id = ss.id
         LEFT JOIN workspaces w ON ss.workspace_id = w.id
         LEFT JOIN projects p2 ON ss.project_id = p2.id
         INNER JOIN organization_members om ON COALESCE(w.organization_id, p2.organization_id) = om.organization_id
         WHERE st.id = $1 AND om.user_id = $2 AND om.status = 'active'`,
        [id, userId]
      );
    }

    if (roleCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const role = roleCheck.rows[0].role;
    if (role !== 'admin' && role !== 'manager') {
      return res.status(403).json({ error: 'Only admins and managers can modify assignees' });
    }

    // Remove the assignee
    await query(
      'DELETE FROM task_assignees WHERE task_id = $1 AND user_id = $2',
      [id, assigneeId]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Error removing assignee:', error);
    res.status(500).json({ error: 'Failed to remove assignee' });
  }
});

export default router;
