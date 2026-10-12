import { Router, Request, Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth.middleware';
import { query } from '../config/database';
import crypto from 'crypto';
import logger from '../config/logger';

const router = Router();

/** Generate a random alphanumeric code */
function generateCode(): string {
  return crypto.randomBytes(8).toString('hex').toUpperCase(); // 16 chars
}

/**
 * GET /api/join-codes/:orgId
 * List active join codes for an org (admin/manager only)
 */
router.get('/:orgId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { orgId } = req.params;

    const memberCheck = await query(
      `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
      [orgId, userId]
    );
    if (memberCheck.rows.length === 0 || !['admin', 'manager'].includes(memberCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Admin or manager access required' });
    }

    const result = await query(
      `SELECT jc.id, jc.code, jc.role, jc.label, jc.max_uses, jc.use_count,
              jc.expires_at, jc.is_active, jc.created_at, jc.project_id,
              u.name as created_by_name, p.name as project_name
       FROM org_join_codes jc
       LEFT JOIN users u ON jc.created_by = u.id
       LEFT JOIN projects p ON jc.project_id = p.id
       WHERE jc.organization_id = $1 AND jc.is_active = true
       ORDER BY jc.created_at DESC`,
      [orgId]
    );

    return res.json({ codes: result.rows });
  } catch (error) {
    logger.error('Error listing join codes:', error);
    return res.status(500).json({ error: 'Failed to list join codes' });
  }
});

/**
 * POST /api/join-codes
 * Create a join code (admin/manager only)
 * Body: { organization_id, role, label?, max_uses?, expires_in_days? }
 */
router.post('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { organization_id, role, label, max_uses, expires_in_days, project_id } = req.body;

    if (!organization_id || !role) {
      return res.status(400).json({ error: 'organization_id and role are required' });
    }
    if (!['admin', 'manager', 'member', 'adviser'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const memberCheck = await query(
      `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
      [organization_id, userId]
    );
    if (memberCheck.rows.length === 0 || !['admin', 'manager'].includes(memberCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Admin or manager access required' });
    }

    const code = generateCode();
    const expiresAt = expires_in_days
      ? new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000)
      : null;

    const result = await query(
      `INSERT INTO org_join_codes (organization_id, code, role, label, max_uses, created_by, expires_at, project_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, code, role, label, max_uses, use_count, expires_at, is_active, created_at, project_id`,
      [organization_id, code, role, label || null, max_uses || null, userId, expiresAt, project_id || null]
    );

    logger.info(`Join code created for org ${organization_id} with role ${role} by user ${userId}`);
    return res.status(201).json({ code: result.rows[0] });
  } catch (error) {
    logger.error('Error creating join code:', error);
    return res.status(500).json({ error: 'Failed to create join code' });
  }
});

/**
 * DELETE /api/join-codes/:codeId
 * Deactivate a join code (admin/manager only)
 */
router.delete('/:codeId', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { codeId } = req.params;

    const codeRow = await query(
      `SELECT jc.organization_id FROM org_join_codes jc WHERE jc.id = $1`,
      [codeId]
    );
    if (codeRow.rows.length === 0) {
      return res.status(404).json({ error: 'Join code not found' });
    }

    const memberCheck = await query(
      `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
      [codeRow.rows[0].organization_id, userId]
    );
    if (memberCheck.rows.length === 0 || !['admin', 'manager'].includes(memberCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Admin or manager access required' });
    }

    await query(`UPDATE org_join_codes SET is_active = false WHERE id = $1`, [codeId]);
    return res.json({ success: true });
  } catch (error) {
    logger.error('Error deactivating join code:', error);
    return res.status(500).json({ error: 'Failed to deactivate join code' });
  }
});

/**
 * POST /api/join-codes/redeem
 * Redeem a join code — authenticated user joins the org with the code's role
 * Body: { code }
 */
router.post('/redeem', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'code is required' });
    }

    const codeRow = await query(
      `SELECT jc.*, o.name as org_name, p.name as project_name
       FROM org_join_codes jc
       JOIN organizations o ON jc.organization_id = o.id
       LEFT JOIN projects p ON jc.project_id = p.id
       WHERE jc.code = $1 AND jc.is_active = true`,
      [code.toUpperCase()]
    );

    if (codeRow.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or inactive join code' });
    }

    const jc = codeRow.rows[0];

    if (jc.expires_at && new Date(jc.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This join code has expired' });
    }

    if (jc.max_uses !== null && jc.use_count >= jc.max_uses) {
      return res.status(400).json({ error: 'This join code has reached its maximum uses' });
    }

    // Check if already a member
    const existing = await query(
      `SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
      [jc.organization_id, userId]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({
        error: 'You are already a member of this organization',
        organization: { id: jc.organization_id, name: jc.org_name, role: jc.role }
      });
    }

    // Add to org
    await query(
      `INSERT INTO organization_members (organization_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'active', NOW())`,
      [jc.organization_id, userId, jc.role]
    );

    // Auto-add to project and assign to all its tasks if the code has a project linked
    if (jc.project_id) {
      const projectRole = jc.role === 'manager' ? 'lead' : 'member';
      await query(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO NOTHING`,
        [jc.project_id, userId, projectRole]
      );
      logger.info(`User ${userId} auto-added to project ${jc.project_id} as ${projectRole} via join code`);

      // Assign to every task (regular and sheet) in the project
      await query(
        `INSERT INTO task_assignees (task_id, user_id, assigned_by)
         SELECT id, $2, $3 FROM tasks WHERE project_id = $1
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [jc.project_id, userId, userId]
      );
      await query(
        `INSERT INTO task_assignees (task_id, user_id, assigned_by)
         SELECT id, $2, $3 FROM sheet_tasks WHERE project_id = $1
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [jc.project_id, userId, userId]
      );
      logger.info(`User ${userId} auto-assigned to all tasks in project ${jc.project_id} via join code`);
    }

    // Increment use count; deactivate if max reached
    await query(
      `UPDATE org_join_codes SET use_count = use_count + 1,
         is_active = CASE WHEN max_uses IS NOT NULL AND use_count + 1 >= max_uses THEN false ELSE is_active END
       WHERE id = $1`,
      [jc.id]
    );

    logger.info(`User ${userId} joined org ${jc.organization_id} via join code ${code} as ${jc.role}`);

    return res.json({
      success: true,
      organization: { id: jc.organization_id, name: jc.org_name, role: jc.role },
      project: jc.project_id ? { id: jc.project_id, name: jc.project_name } : null
    });
  } catch (error) {
    logger.error('Error redeeming join code:', error);
    return res.status(500).json({ error: 'Failed to redeem join code' });
  }
});

export default router;
