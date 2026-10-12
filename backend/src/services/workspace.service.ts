import { google, sheets_v4, drive_v3 } from 'googleapis';
import { query } from '../config/database';
import logger from '../config/logger';
import { SheetsProtectionService } from './sheets-protection.service';
import { EqualizerService } from './equalizer.service';

interface ColumnMapping {
  wbsCode?: number;
  title: number | number[];
  status: number;
  priority: number;
  assignee: number;
  dueDate: number;
  startDate?: number;
  description?: number;
  progress?: number;
  team_id?: string;
}

interface SheetTask {
  sheetRowIndex: number;
  title: string;
  wbs_code?: string;
  parent_task_id?: string | null;
  status: string;
  priority: string;
  assigneeEmail?: string;
  startDate?: Date;
  dueDate?: Date;
  description?: string;
  complexityWeight?: number;
  isAbsolute?: boolean;
  progress_percent?: number;
  luxury_weight?: number;
  team_id?: string;
  extraData?: Record<string, any>;
}

interface SyncResult {
  success: boolean;
  tasksCreated: number;
  tasksUpdated: number;
  tasksDeleted: number;
  error?: string;
}

export class WorkspaceSyncService {

  /**
   * Get OAuth2 client for a user
   */
  private async getAuthClient(userId: string) {
    const userResult = await query(
      'SELECT access_token, refresh_token FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }

    const { access_token, refresh_token } = userResult.rows[0];

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token,
      refresh_token
    });

    // Listen for token refreshes and persist them
    oauth2Client.on('tokens', (tokens: any) => {
      if (tokens.refresh_token) {
        query('UPDATE users SET access_token = $1, refresh_token = $2 WHERE id = $3', [tokens.access_token, tokens.refresh_token, userId])
          .catch(err => logger.error('Error persisting refreshed tokens:', err));
      } else if (tokens.access_token) {
        query('UPDATE users SET access_token = $1 WHERE id = $2', [tokens.access_token, userId])
          .catch(err => logger.error('Error persisting refreshed access token:', err));
      }
    });

    return oauth2Client;
  }

  /**
   * List all sheets in a Google Drive folder
   */
  async listSheetsInFolder(userId: string, folderId: string): Promise<any[]> {
    const auth = await this.getAuthClient(userId);
    const drive = google.drive({ version: 'v3', auth });

    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
      fields: 'files(id, name, modifiedTime, owners)'
    });

    return response.data.files || [];
  }

  /**
   * Auto-detect column mapping from sheet headers
   */
  async detectColumnMapping(userId: string, sheetId: string): Promise<ColumnMapping> {
    const auth = await this.getAuthClient(userId);
    const sheets = google.sheets({ version: 'v4', auth });

    // First, get all sheet tabs in the spreadsheet
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: 'sheets.properties.title'
    });

    const sheetTabs = (spreadsheet.data.sheets || []).map((s: any) => s.properties?.title) || ['Sheet1'];
    logger.info(`Found ${sheetTabs.length} tabs in spreadsheet: ${sheetTabs.join(', ')}`);

    // Try each tab until we find one with headers
    for (const tabName of sheetTabs) {
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: `'${tabName}'!1:1`
        });

        const headers = (response.data.values?.[0] || []).map((h: string) => String(h).toLowerCase().trim());
        logger.info(`Tab '${tabName}' headers: ${headers.join(', ')}`);

        if (headers.length === 0) continue;

        const colWbs = headers.findIndex((h: string) => /wbs.?id|wbs/i.test(h));
        const colMod = headers.findIndex((h: string) => /module|l1/i.test(h));
        const colTx = headers.findIndex((h: string) => /transaction|l2/i.test(h));
        const colTask = headers.findIndex((h: string) => /task\b|l3/i.test(h));
        const colSub = headers.findIndex((h: string) => /subtask|l4/i.test(h));

        let titleMapping: number | number[] = -1;
        if (colMod !== -1 || colTx !== -1 || colSub !== -1) {
            titleMapping = [colMod, colTx, colTask, colSub].filter(i => i !== -1);
        } else {
            titleMapping = headers.findIndex((h: string) => /tasks|title|task|name|item/i.test(h));
        }

        const mapping: ColumnMapping = {
          wbsCode: colWbs !== -1 ? colWbs : undefined,
          title: titleMapping,
          status: headers.findIndex((h: string) => /status|state/i.test(h)),
          priority: headers.findIndex((h: string) => /priority|importance/i.test(h)),
          assignee: headers.findIndex((h: string) => /assignee|assigned|owner|email/i.test(h)),
          dueDate: headers.findIndex((h: string) => /due|deadline|date.finished|duedate/i.test(h)),
          startDate: headers.findIndex((h: string) => /start|date.started|startdate/i.test(h)),
          description: headers.findIndex((h: string) => /description|desc|details|notes/i.test(h)),
          progress: headers.findIndex((h: string) => /progress|completion|%|percent/i.test(h))
        };

        // If we found at least title column, use this tab
        if (mapping.title !== -1) {
          logger.info(`Using tab '${tabName}' with mapping: ${JSON.stringify(mapping)}`);
          // Store the tab name in the mapping for later use
          (mapping as any).sheetTab = tabName;
          return mapping;
        }
      } catch (err) {
        logger.warn(`Error reading tab '${tabName}':`, err);
      }
    }

    // Default fallback
    logger.warn('No valid headers found, using column 0 as title');
    return {
      title: 0,
      status: -1,
      priority: -1,
      assignee: -1,
      dueDate: -1,
      description: -1,
      progress: -1
    };
  }

  /**
   * Parse WBS code from a title string
   */
  private parseWbsPrefix(title: string): { wbs: string, cleanTitle: string } {
    const match = title.match(/^(\d+(?:\.\d+)*\.?)\s+(.+)$/);
    if (match) {
      return {
        wbs: match[1].replace(/\.$/, ''),
        cleanTitle: match[2].trim()
      };
    }
    return { wbs: '', cleanTitle: title.trim() };
  }

  /**
   * Determine if a row is a section header (title but no other data)
   */
  private isSectionHeader(row: any[], mapping: ColumnMapping): boolean {
    const assignee = mapping.assignee !== -1 ? row[mapping.assignee] : undefined;
    const dueDate = mapping.dueDate !== -1 ? row[mapping.dueDate] : undefined;
    // A row is a header if it has a title but lacks core task metadata
    return !assignee && !dueDate;
  }

  /**
   * Parse sheet data into tasks
   */
  async parseSheetTasks(
    userId: string,
    sheetId: string,
    columnMapping: ColumnMapping,
    statusOverrides?: Record<string, string>
  ): Promise<SheetTask[]> {
    const auth = await this.getAuthClient(userId);
    const sheets = google.sheets({ version: 'v4', auth });

    // Use the detected sheet tab, or default to first sheet
    const sheetTab = (columnMapping as any).sheetTab || 'Sheet1';
    const range = `'${sheetTab}'!A:Z`;
    logger.info(`Reading data from range: ${range}`);

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: range
    });

    const rows = response.data.values || [];
    logger.info(`Found ${rows.length} rows in sheet`);

    if (rows.length <= 1) return []; // Only header or empty

    const tasks: SheetTask[] = [];

    // Skip header row
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      let rawTitle: any;
      if (Array.isArray(columnMapping.title)) {
        for (const colIdx of columnMapping.title) {
          if (row[colIdx] && String(row[colIdx]).trim() !== '') {
            rawTitle = row[colIdx];
            break;
          }
        }
      } else {
        rawTitle = row[columnMapping.title as number];
      }

      if (!rawTitle || String(rawTitle).trim() === '') continue; // Skip empty rows

      let wbs = undefined;
      let cleanTitle = String(rawTitle).trim();

      if (columnMapping.wbsCode !== undefined && row[columnMapping.wbsCode]) {
        wbs = String(row[columnMapping.wbsCode]).trim();
      } else {
        const parsed = this.parseWbsPrefix(cleanTitle);
        wbs = parsed.wbs;
        cleanTitle = parsed.cleanTitle;
      }
      const statusRaw = row[columnMapping.status];
      const priorityRaw = row[columnMapping.priority];
      const assigneeRaw = row[columnMapping.assignee];
      const isHeader = this.isSectionHeader(row, columnMapping);
      
      const progressRaw = columnMapping.progress !== undefined && columnMapping.progress !== -1
        ? row[columnMapping.progress]
        : undefined;

      const task: SheetTask = {
        sheetRowIndex: i,
        title: cleanTitle || String(rawTitle).trim(),
        wbs_code: wbs || undefined,
        status: this.normalizeStatusWithOverrides(statusRaw, statusOverrides),
        priority: this.normalizePriority(priorityRaw),
        assigneeEmail: assigneeRaw ? String(assigneeRaw).trim() : undefined,
        startDate: columnMapping.startDate !== undefined && columnMapping.startDate !== -1 
          ? this.parseDate(row[columnMapping.startDate]) 
          : undefined,
        dueDate: this.parseDate(row[columnMapping.dueDate]),
        description: columnMapping.description !== undefined && columnMapping.description !== -1
          ? row[columnMapping.description]
          : undefined,
        complexityWeight: wbs ? wbs.split('.').length : 1,
        isAbsolute: true, // ALL synced tasks are locked by default (advisor-only)
        progress_percent: this.parseProgress(progressRaw),
        luxury_weight: 1, // Default for now, can be expanded to parse from sheet later
        team_id: columnMapping.team_id,
        extraData: { 
          is_header: isHeader, 
          synced_from_sheet: true
        }
      };

      tasks.push(task);
    }

    logger.info(`Parsed ${tasks.length} tasks from sheet`);
    return tasks;
  }

  /**
   * Sync a sheet's tasks to database
   */
  async syncSheet(syncedSheetId: string, statusOverrides?: Record<string, string>): Promise<SyncResult> {
    try {
      // Get synced sheet info
      const sheetResult = await query(
        `SELECT ss.*, w.created_by, w.organization_id 
         FROM synced_sheets ss 
         JOIN workspaces w ON ss.workspace_id = w.id 
         WHERE ss.id = $1`,
        [syncedSheetId]
      );

      if (sheetResult.rows.length === 0) {
        return { success: false, tasksCreated: 0, tasksUpdated: 0, tasksDeleted: 0, error: 'Sheet not found' };
      }

      const sheet = sheetResult.rows[0];

      // Re-detect column mapping on every sync to ensure accuracy
      const columnMapping = await this.detectColumnMapping(sheet.created_by, sheet.sheet_id);
      logger.info(`Re-detected column mapping: ${JSON.stringify(columnMapping)}`);

      // Update stored column mapping
      await query(
        `UPDATE synced_sheets SET column_mapping = $1 WHERE id = $2`,
        [JSON.stringify(columnMapping), syncedSheetId]
      );

      // Parse tasks from Google Sheet (pass optional status overrides from column_mappings table)
      const sheetTasks = await this.parseSheetTasks(sheet.created_by, sheet.sheet_id, columnMapping, statusOverrides);

      // Map wbs_code -> task ID for parent resolution
      const wbsToId: Record<string, string> = {};
      let tasksCreated = 0;
      let tasksUpdated = 0;

      // Upsert each task
      for (const task of sheetTasks) {
        // Resolve parent_task_id from WBS
        let parentTaskId: string | null = null;
        if (task.wbs_code && task.wbs_code.includes('.')) {
          const parts = task.wbs_code.split('.');
          const parentWbs = parts.slice(0, -1).join('.');
          parentTaskId = wbsToId[parentWbs] || null;
        }

        const result = await query(
          `INSERT INTO sheet_tasks (
            synced_sheet_id, project_id, team_id, sheet_row_index, title, description,
            status, priority, assignee_email, due_date, start_date,
            wbs_code, parent_task_id, complexity_weight, is_absolute,
            progress_percent, luxury_weight, synced_at, updated_at
          )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())
           ON CONFLICT(synced_sheet_id, sheet_row_index)
          DO UPDATE SET
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            status = EXCLUDED.status,
            priority = EXCLUDED.priority,
            assignee_email = EXCLUDED.assignee_email,
            due_date = EXCLUDED.due_date,
            start_date = EXCLUDED.start_date,
            wbs_code = EXCLUDED.wbs_code,
            parent_task_id = EXCLUDED.parent_task_id,
            project_id = EXCLUDED.project_id,
            team_id = EXCLUDED.team_id,
            complexity_weight = EXCLUDED.complexity_weight,
            is_absolute = EXCLUDED.is_absolute,
            progress_percent = EXCLUDED.progress_percent,
            luxury_weight = EXCLUDED.luxury_weight,
            synced_at = NOW(),
            updated_at = NOW()
          RETURNING id, (xmax = 0) AS inserted`,
          [
            syncedSheetId, sheet.project_id, sheet.team_id, task.sheetRowIndex, task.title, task.description, 
            task.status, task.priority, task.assigneeEmail, task.dueDate, task.startDate,
            task.wbs_code || null, parentTaskId, task.complexityWeight || 1, task.isAbsolute || false,
            task.progress_percent || 0, task.luxury_weight || 1
          ]
        );

        const dbTaskId = result.rows[0].id;
        if (task.wbs_code) wbsToId[task.wbs_code] = dbTaskId;

        if (result.rows[0]?.inserted) {
          tasksCreated++;
        } else {
          tasksUpdated++;
        }
      }

      // Delete tasks that no longer exist in sheet
      const validRowIndexes = sheetTasks.map(t => t.sheetRowIndex);
      const deleteResult = await query(
        `DELETE FROM sheet_tasks WHERE synced_sheet_id = $1 AND sheet_row_index != ALL($2::int[])`,
        [syncedSheetId, validRowIndexes]
      );
      const tasksDeleted = deleteResult.rowCount || 0;

      // Update sync status
      await query(
        `UPDATE synced_sheets SET last_synced_at = NOW(), row_count = $1, sync_status = 'active' WHERE id = $2`,
        [sheetTasks.length, syncedSheetId]
      );

      // Log sync
      await this.logSync(sheet.workspace_id, 'sync_completed', {
        sheetId: syncedSheetId,
        tasksCreated,
        tasksUpdated,
        tasksDeleted
      });

      logger.info(`Synced sheet ${syncedSheetId}: ${tasksCreated} created, ${tasksUpdated} updated, ${tasksDeleted} deleted`);

      // ── Equalizer: Register ghost members for unrecognized emails ──
      try {
        const uniqueEmails = [...new Set(
          sheetTasks
            .filter(t => t.assigneeEmail && t.assigneeEmail.includes('@'))
            .map(t => t.assigneeEmail!.toLowerCase().trim())
        )];

        if (uniqueEmails.length > 0 && sheet.organization_id) {
          for (const email of uniqueEmails) {
            await EqualizerService.registerSheetMember(sheet.organization_id, email);
          }
          logger.info(`Equalizer: Processed ${uniqueEmails.length} assignee emails from sheet sync`);
        }
      } catch (eqError: any) {
        logger.warn('Equalizer: Ghost member registration failed (non-fatal):', eqError.message);
      }

      return { success: true, tasksCreated, tasksUpdated, tasksDeleted };

    } catch (error: any) {
      logger.error('Sheet sync error:', error);
      return { success: false, tasksCreated: 0, tasksUpdated: 0, tasksDeleted: 0, error: error.message };
    }
  }

  /**
   * Sync all sheets in a workspace
   */
  async syncWorkspace(workspaceId: string): Promise<void> {
    await query(`UPDATE workspaces SET sync_status = 'syncing' WHERE id = $1`, [workspaceId]);

    try {
      const sheetsResult = await query(
        `SELECT id FROM synced_sheets WHERE workspace_id = $1 AND sync_status = 'active'`,
        [workspaceId]
      );

      for (const sheet of sheetsResult.rows) {
        await this.syncSheet(sheet.id);
      }

      await query(
        `UPDATE workspaces SET sync_status = 'active', last_synced_at = NOW(), sync_error = NULL WHERE id = $1`,
        [workspaceId]
      );

    } catch (error: any) {
      await query(
        `UPDATE workspaces SET sync_status = 'error', sync_error = $1 WHERE id = $2`,
        [error.message, workspaceId]
      );
      throw error;
    }
  }

  /**
   * Connect a Google Sheet to workspace
   */
  async connectSheet(
    workspaceId: string,
    sheetId: string,
    sheetName: string,
    projectId?: string,
    teamId?: string
  ): Promise<string> {
    // Get workspace to find user
    const wsResult = await query('SELECT created_by FROM workspaces WHERE id = $1', [workspaceId]);
    if (wsResult.rows.length === 0) throw new Error('Workspace not found');

    const userId = wsResult.rows[0].created_by;

    // Auto-detect column mapping
    const columnMapping = await this.detectColumnMapping(userId, sheetId);

    // Upsert synced sheet — two different conflict paths depending on whether team_id is set
    let syncedSheetId: string;

    if (teamId) {
      // Team-based: conflict on (team_id, sheet_id)
      const result = await query(
        `INSERT INTO synced_sheets (workspace_id, sheet_id, sheet_name, column_mapping, project_id, team_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (team_id, sheet_id) DO UPDATE SET
           sheet_name = EXCLUDED.sheet_name,
           column_mapping = EXCLUDED.column_mapping,
           project_id = EXCLUDED.project_id,
           workspace_id = EXCLUDED.workspace_id,
           updated_at = NOW()
         RETURNING id`,
        [workspaceId, sheetId, sheetName, JSON.stringify(columnMapping), projectId, teamId]
      );
      syncedSheetId = result.rows[0].id;
    } else {
      // Project-based (no team): deduplicate on (workspace_id, sheet_id) manually
      const existing = await query(
        `SELECT id FROM synced_sheets WHERE workspace_id = $1 AND sheet_id = $2 AND team_id IS NULL`,
        [workspaceId, sheetId]
      );
      if (existing.rows.length > 0) {
        syncedSheetId = existing.rows[0].id;
        await query(
          `UPDATE synced_sheets SET sheet_name = $1, column_mapping = $2, project_id = $3, updated_at = NOW() WHERE id = $4`,
          [sheetName, JSON.stringify(columnMapping), projectId || null, syncedSheetId]
        );
      } else {
        const result = await query(
          `INSERT INTO synced_sheets (workspace_id, sheet_id, sheet_name, column_mapping, project_id, team_id)
           VALUES ($1, $2, $3, $4, $5, NULL)
           RETURNING id`,
          [workspaceId, sheetId, sheetName, JSON.stringify(columnMapping), projectId || null]
        );
        syncedSheetId = result.rows[0].id;
      }
    }

    // Initial sync
    await this.syncSheet(syncedSheetId);

    return syncedSheetId;
  }

  /**
   * Create a WBS Template Google Sheet
   */
  async createWbsTemplate(userId: string, organizationId: string, folderId?: string, teamId?: string): Promise<{ id: string, name: string, url: string }> {
    const auth = await this.getAuthClient(userId);
    
    // Fetch email separately for protection service
    const userRes = await query('SELECT email FROM users WHERE id = $1', [userId]);
    const userEmail = userRes.rows[0]?.email;

    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });

    const title = 'WBS Template';

    // 1. Create Spreadsheet
    const spreadsheet = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title }
      }
    });

    const spreadsheetId = spreadsheet.data.spreadsheetId!;
    const url = spreadsheet.data.spreadsheetUrl!;
    const sheetId = spreadsheet.data.sheets?.[0].properties?.sheetId || 0;

    // Rename first sheet to "Tasks"
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId, title: 'Tasks' },
              fields: 'title'
            }
          }
        ]
      }
    });

    // 2. Add Headers + Sample WBS hierarchy data
    const headers = [
      'WBS ID', 'Module (L1)', 'Transaction (L2)', 'Task (L3)', 'Subtask (L4)', 
      'Description', 'Assigned To', 'Priority', 'Status', 'Start Date', 
      'End Date', 'Duration', 'Dependencies', 'Progress %', 'Remarks'
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Tasks!A1:O12',
      valueInputOption: 'RAW',
      requestBody: {
        values: [
          headers,
          ['1', 'Project Planning', '', '', '', 'Overall project planning phase', '', 'High', 'In Progress', '', '', '5d', '', '', ''],
          ['1.1', '', 'Requirements Gathering', '', '', 'Collect and document requirements', '', 'High', 'In Progress', '', '', '2d', '', '', ''],
          ['1.1.1', '', '', 'Stakeholder Interviews', '', 'Interview key stakeholders', '', 'High', 'Complete', '', '', '1d', '', '100', ''],
          ['1.1.2', '', '', 'Document Requirements', '', 'Write requirements specification', '', 'Medium', 'In Progress', '', '', '1d', '1.1.1', '50', ''],
          ['1.2', '', 'Technical Design', '', '', 'System architecture and design', '', 'High', 'Not Started', '', '', '3d', '', '', ''],
          ['1.2.1', '', '', 'Architecture Diagram', '', 'Create system architecture', '', 'High', 'Not Started', '', '', '1d', '', '0', ''],
          ['1.2.2', '', '', 'Database Schema', '', 'Design database structure', '', 'Medium', 'Not Started', '', '', '2d', '1.2.1', '0', ''],
          ['2', 'Development', '', '', '', 'Implementation phase', '', 'High', 'Not Started', '', '', '15d', '', '', ''],
          ['2.1', '', 'Frontend Development', '', '', 'Build user interface', '', 'Medium', 'Not Started', '', '', '10d', '', '', ''],
          ['2.2', '', 'Backend Development', '', '', 'Build server and API', '', 'Medium', 'Not Started', '', '', '12d', '', '', ''],
          ['3', 'Testing', '', '', '', 'QA and release phase', '', 'Medium', 'Not Started', '', '', '5d', '', '', '']
        ]
      }
    });

    // 3. Format Headers (Bold, Dark Slate background, White text) and set column widths
    const COL_COUNT = 15;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          // Header row formatting
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: COL_COUNT },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                  backgroundColor: { red: 0.1, green: 0.3, blue: 0.5 }, // Dark Slate
                  horizontalAlignment: 'CENTER',
                  verticalAlignment: 'MIDDLE'
                }
              },
              fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment,verticalAlignment)'
            }
          },
          // Auto-resize all columns
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex: COL_COUNT
              }
            }
          },
          // Freeze header row
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount'
            }
          },
          // Add alternating row colors for readability
          {
            addBanding: {
              bandedRange: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 12, startColumnIndex: 0, endColumnIndex: COL_COUNT },
                rowProperties: {
                  headerColor: { red: 0.1, green: 0.3, blue: 0.5 },
                  firstBandColor: { red: 1, green: 1, blue: 1 },
                  secondBandColor: { red: 0.94, green: 0.96, blue: 0.99 }
                }
              }
            }
          }
        ]
      }
    });

    // 4. Move to folder if provided
    if (folderId && folderId !== 'root') {
      try {
        const file = await drive.files.get({ fileId: spreadsheetId, fields: 'parents' });
        const previousParents = file.data.parents?.join(',') || '';
        await drive.files.update({
          fileId: spreadsheetId,
          addParents: folderId,
          removeParents: previousParents,
          fields: 'id, parents'
        });
      } catch (moveError) {
        logger.warn('Could not move template to folder:', moveError);
      }
    }

    // 5. Create synced_sheets record so it's immediately visible
    // Find workspaceId for this org/user
    const workspaceResult = await query(
      'SELECT id FROM workspaces WHERE organization_id = $1 AND created_by = $2 LIMIT 1',
      [organizationId, userId]
    );

    if (workspaceResult.rows.length > 0) {
      const workspaceId = workspaceResult.rows[0].id;
      await query(
        `INSERT INTO synced_sheets (workspace_id, team_id, sheet_id, sheet_name, column_mapping, sync_status, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, 'active', NOW())
         ON CONFLICT (workspace_id, sheet_id) DO UPDATE SET
           team_id = EXCLUDED.team_id,
           sheet_name = EXCLUDED.sheet_name,
           updated_at = NOW()`,
        [
          workspaceId,
          teamId || null,
          spreadsheetId,
          title,
          JSON.stringify({
            wbsCode: 0,
            title: [1, 2, 3, 4],
            description: 5,
            assignee: 6,
            priority: 7,
            status: 8,
            startDate: 9,
            dueDate: 10,
            progress: 13,
            sheetTab: 'Tasks'
          })
        ]
      );
    }

    // 6. Protect header row
    try {
      const token = (await auth.getAccessToken()).token;
      if (token) {
        await SheetsProtectionService.protectHeaderRow(token, spreadsheetId, sheetId, [userEmail]);
      }
    } catch (protError) {
      logger.warn('Could not protect template header row:', protError);
    }

    return { id: spreadsheetId, name: title, url };
  }

  /**
   * Create a new workspace from a Drive folder
   */
  async createWorkspace(
    userId: string,
    organizationId: string,
    folderId: string,
    folderName: string
  ): Promise<string> {
    const result = await query(
      `INSERT INTO workspaces (created_by, organization_id, root_folder_id, root_folder_name, name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, organizationId, folderId, folderName, folderName]
    );

    return result.rows[0].id;
  }

  /**
   * Get synced tasks for display
   */
  async getSyncedTasks(syncedSheetId: string): Promise<any[]> {
    const result = await query(
      `SELECT * FROM sheet_tasks WHERE synced_sheet_id = $1 ORDER BY sheet_row_index`,
      [syncedSheetId]
    );
    return result.rows;
  }

  /**
   * Get all tasks across workspace
   */
  async getWorkspaceTasks(workspaceId: string): Promise<any[]> {
    const result = await query(
      `SELECT st.*, ss.sheet_name, ss.sheet_id as google_sheet_id
       FROM sheet_tasks st
       JOIN synced_sheets ss ON st.synced_sheet_id = ss.id
       WHERE ss.workspace_id = $1
       ORDER BY ss.sheet_name, st.sheet_row_index`,
      [workspaceId]
    );
    return result.rows;
  }

  // === Helper Methods ===

  /** Checks user-defined column_mappings overrides first, then falls back to auto-detection */
  private normalizeStatusWithOverrides(
    status: string | undefined,
    overrides?: Record<string, string>
  ): string {
    if (status && overrides) {
      const key = status.toLowerCase().trim();
      if (overrides[key]) return overrides[key];
    }
    return this.normalizeStatus(status);
  }

  private normalizeStatus(status: string | undefined): string {
    if (!status) return 'todo';
    const s = status.toLowerCase().trim();
    if (/done|complete|finished|closed/i.test(s)) return 'done';
    if (/progress|doing|working|started/i.test(s)) return 'in-progress';
    if (/review|check|pending|waiting/i.test(s)) return 'review';
    return 'todo';
  }

  private normalizePriority(priority: string | undefined): string {
    if (!priority) return 'medium';
    const p = priority.toLowerCase().trim();
    if (/critical|urgent|highest/i.test(p)) return 'critical';
    if (/high|important/i.test(p)) return 'high';
    if (/low|minor/i.test(p)) return 'low';
    return 'medium';
  }

  private parseDate(dateStr: string | undefined): Date | undefined {
    if (!dateStr) return undefined;
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? undefined : date;
  }

  private async logSync(workspaceId: string, eventType: string, details: any): Promise<void> {
    await query(
      `INSERT INTO sync_logs (workspace_id, event_type, details) VALUES ($1, $2, $3)`,
      [workspaceId, eventType, JSON.stringify(details)]
    );
  }

  private parseProgress(value: any): number {
    if (value === undefined || value === null || value === '') return 0;
    
    // If it's a percentage string (e.g., "50%")
    if (typeof value === 'string' && value.includes('%')) {
      const num = parseFloat(value.replace('%', ''));
      return isNaN(num) ? 0 : Math.min(100, Math.max(0, num));
    }
    
    // If it's a decimal (e.g., 0.5 for 50%)
    const num = parseFloat(value);
    if (isNaN(num)) return 0;
    
    // Heuristic: if value <= 1 && value > 0, treat as decimal percentage (0.5 -> 50)
    // UNLESS the user explicitly type 100 which is 100%
    if (num <= 1 && num > 0) return Math.round(num * 100);
    
    return Math.min(100, Math.max(0, num));
  }

  /**
   * Convert column index to letter (0 = A, 1 = B, 26 = AA, etc.)
   */
  private getColumnLetter(index: number): string {
    let letter = '';
    while (index >= 0) {
      letter = String.fromCharCode((index % 26) + 65) + letter;
      index = Math.floor(index / 26) - 1;
    }
    return letter;
  }

  /**
   * Convert display status to sheet-friendly format
   */
  private denormalizeStatus(status: string): string {
    switch (status) {
      case 'done': return 'Complete';
      case 'in-progress': return 'In Progress';
      case 'review': return 'Review';
      case 'todo': return 'To Do';
      default: return status;
    }
  }

  /**
   * Convert display priority to sheet-friendly format
   */
  private denormalizePriority(priority: string): string {
    switch (priority) {
      case 'critical': return 'Critical';
      case 'high': return 'High';
      case 'medium': return 'Medium';
      case 'low': return 'Low';
      default: return priority;
    }
  }

  /**
   * Update a synced task field and write back to Google Sheet
   */
  async updateSheetTask(
    taskId: string,
    field: 'status' | 'priority' | 'assignee' | 'due_date' | 'title' | 'description' | 'progress',
    value: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Get task and sheet info
      const taskResult = await query(
        `SELECT st.*, ss.sheet_id, ss.column_mapping, w.created_by as user_id
         FROM sheet_tasks st
         JOIN synced_sheets ss ON st.synced_sheet_id = ss.id
         JOIN workspaces w ON ss.workspace_id = w.id
         WHERE st.id = $1`,
        [taskId]
      );

      if (taskResult.rows.length === 0) {
        return { success: false, error: 'Task not found' };
      }

      const task = taskResult.rows[0];
      const columnMapping = task.column_mapping as any;

      // Determine which column to update
      let columnIndex: number;
      let sheetValue: string;
      let dbField: string;
      let dbValue: any;

      switch (field) {
        case 'status':
          columnIndex = columnMapping.status;
          sheetValue = this.denormalizeStatus(value);
          dbField = 'status';
          dbValue = value;
          break;
        case 'priority':
          columnIndex = columnMapping.priority;
          sheetValue = this.denormalizePriority(value);
          dbField = 'priority';
          dbValue = value;
          break;
        case 'assignee':
          columnIndex = columnMapping.assignee;
          sheetValue = value;
          dbField = 'assignee_email';
          dbValue = value;
          break;
        case 'due_date':
          columnIndex = columnMapping.dueDate;
          sheetValue = value;
          dbField = 'due_date';
          dbValue = value ? new Date(value) : null;
          break;
        case 'title':
          // If title mapping is an array, use the one matching the WBS level or default to the first one
          if (Array.isArray(columnMapping.title)) {
            const level = task.wbs_code ? task.wbs_code.split('.').length : 1;
            // Level 1 is index 0 in the array [L1, L2, L3, L4]
            columnIndex = columnMapping.title[Math.min(level - 1, columnMapping.title.length - 1)];
          } else {
            columnIndex = columnMapping.title;
          }
          sheetValue = value;
          dbField = 'title';
          dbValue = value;
          break;
        case 'description':
          columnIndex = columnMapping.description;
          sheetValue = value;
          dbField = 'description';
          dbValue = value;
          break;
        case 'progress':
          columnIndex = columnMapping.progress;
          sheetValue = value;
          dbField = 'progress_percent';
          dbValue = this.parseProgress(value);
          break;
        default:
          return { success: false, error: 'Invalid field' };
      }

      if (columnIndex === -1 || columnIndex === undefined) {
        return { success: false, error: `Column for ${field} not mapped in sheet` };
      }

      // Get sheet tab name
      const sheetTab = columnMapping.sheetTab || 'Sheet1';
      const columnLetter = this.getColumnLetter(columnIndex);
      const rowNumber = task.sheet_row_index + 1; // +1 because sheet is 1-indexed
      const range = `'${sheetTab}'!${columnLetter}${rowNumber}`;

      logger.info(`Writing to Google Sheet: ${range} = "${sheetValue}"`);

      // Write to Google Sheet
      const auth = await this.getAuthClient(task.user_id);
      const sheets = google.sheets({ version: 'v4', auth });

      await sheets.spreadsheets.values.update({
        spreadsheetId: task.sheet_id,
        range: range,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[sheetValue]]
        }
      });

      // Update local database
      await query(
        `UPDATE sheet_tasks SET ${dbField} = $1, updated_at = NOW() WHERE id = $2`,
        [dbValue, taskId]
      );

      logger.info(`Successfully updated sheet task ${taskId}: ${field} = ${value}`);
      return { success: true };

    } catch (error: any) {
      logger.error('Error updating sheet task:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Batch update multiple fields on a synced task
   */
  async updateSheetTaskMultiple(
    taskId: string,
    updates: Partial<{ status: string; priority: string; assignee: string; due_date: string }>
  ): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    for (const [field, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const result = await this.updateSheetTask(
          taskId,
          field as 'status' | 'priority' | 'assignee' | 'due_date',
          value
        );
        if (!result.success && result.error) {
          errors.push(`${field}: ${result.error}`);
        }
      }
    }

    return { success: errors.length === 0, errors };
  }

  /**
   * Import team groups + members from a synced Google Sheet.
   * Auto-detects team-style columns:
   *   TEAM CODE, MEMBER #, STUDENT ID, LASTNAME, FIRSTNAME, EMAIL, PROPOSED PROJECT, ADVISER
   */
  async importTeamsFromSheet(
    syncedSheetId: string
  ): Promise<{ success: boolean; teamsCreated: number; membersCreated: number; error?: string }> {
    try {
      // Get sheet info
      const sheetResult = await query(
        `SELECT ss.*, w.created_by as user_id, w.organization_id
         FROM synced_sheets ss
         JOIN workspaces w ON ss.workspace_id = w.id
         WHERE ss.id = $1`,
        [syncedSheetId]
      );

      if (sheetResult.rows.length === 0) {
        return { success: false, teamsCreated: 0, membersCreated: 0, error: 'Sheet not found' };
      }

      const sheet = sheetResult.rows[0];
      const auth = await this.getAuthClient(sheet.user_id);
      const sheets = google.sheets({ version: 'v4', auth });

      // Get all sheet tabs
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: sheet.sheet_id,
        fields: 'sheets.properties.title'
      });
      const sheetTabs = spreadsheet.data.sheets?.map(s => s.properties?.title) || ['Sheet1'];

      let allRows: string[][] = [];
      let headers: string[] = [];
      let foundTab = false;

      for (const tabName of sheetTabs) {
        try {
          const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheet.sheet_id,
            range: `'${tabName}'!A:Z`
          });

          const rows = response.data.values || [];
          if (rows.length < 2) continue;

          // Scan through the first 10 rows to find the actual header row
          // (sheets often have instruction text or merged header cells before the real columns)
          for (let headerRowIdx = 0; headerRowIdx < Math.min(10, rows.length - 1); headerRowIdx++) {
            const h = rows[headerRowIdx].map((c: string) => String(c).toLowerCase().trim());
            // Check if this row looks like column headers (has at least 3+ distinct team-related headers)
            const hasTeamCode = h.some((c: string) => /team.?code/i.test(c));
            const hasMemberNum = h.some((c: string) => /member/i.test(c));
            const hasLastname = h.some((c: string) => /last.?name|surname/i.test(c));
            const hasFirstname = h.some((c: string) => /first.?name|given/i.test(c));
            const hasEmail = h.some((c: string) => /email|e-mail/i.test(c));

            const matchCount = [hasTeamCode, hasMemberNum, hasLastname, hasFirstname, hasEmail].filter(Boolean).length;

            if (matchCount >= 3) {
              headers = h;
              allRows = rows.slice(headerRowIdx + 1) as string[][]; // skip everything up to and including header
              foundTab = true;
              logger.info(`importTeams: Using tab '${tabName}', header at row ${headerRowIdx + 1}, with ${allRows.length} data rows`);
              break;
            }
          }

          if (foundTab) break;
        } catch (err) {
          logger.warn(`importTeams: Error reading tab '${tabName}':`, err);
        }
      }

      if (!foundTab || allRows.length === 0) {
        return { success: false, teamsCreated: 0, membersCreated: 0, error: 'No team-formatted sheet tab found. Expected columns like TEAM CODE, MEMBER #, LASTNAME, FIRSTNAME.' };
      }

      // Detect column indexes
      logger.info(`importTeams: Raw headers: ${JSON.stringify(headers)}`);
      const colTeamCode = headers.findIndex(h => /team.?code/i.test(h));
      const colMemberNum = headers.findIndex(h => /member.?#|member.?no|member.?num/i.test(h));
      // Match 'student id', 'student no', 'student number', 'std id', 'sn', or standalone 'id' (not 'team id')
      let colStudentId = headers.findIndex(h => /student.?id|student.?(no|number)|\bstd.?id\b|\bs\.?n\.?\b/i.test(h));
      if (colStudentId === -1) {
        colStudentId = headers.findIndex(h => {
          const cleaned = h.trim();
          // 'ID' alone, but not 'team id' or 'member id'
          return /^id$/i.test(cleaned) || /^id.?(num|no|number)?$/i.test(cleaned);
        });
      }
      const colLastname = headers.findIndex(h => /last.?name|surname/i.test(h));
      const colFirstname = headers.findIndex(h => /first.?name|given/i.test(h));
      const colEmail = headers.findIndex(h => /email|e-mail/i.test(h));
      const colProject = headers.findIndex(h => /project|proposed|title/i.test(h));
      const colAdviser = headers.findIndex(h => /adviser|advisor/i.test(h));

      logger.info(`importTeams: Column mapping — teamCode:${colTeamCode} memberNum:${colMemberNum} studentId:${colStudentId} lastname:${colLastname} firstname:${colFirstname} email:${colEmail} project:${colProject} adviser:${colAdviser}`);

      // Group rows by team code
      const teamMap = new Map<string, { rows: string[][]; project: string; adviser: string }>();

      for (const row of allRows) {
        const teamCode = colTeamCode !== -1 ? String(row[colTeamCode] || '').trim() : '';
        if (!teamCode) continue;

        if (!teamMap.has(teamCode)) {
          teamMap.set(teamCode, {
            rows: [],
            project: colProject !== -1 ? String(row[colProject] || '').trim() : '',
            adviser: colAdviser !== -1 ? String(row[colAdviser] || '').trim() : ''
          });
        }
        const team = teamMap.get(teamCode)!;
        team.rows.push(row);
        // Project/adviser may only appear on the first member row, or could appear on any
        if (colProject !== -1 && !team.project && row[colProject]) {
          team.project = String(row[colProject]).trim();
        }
        if (colAdviser !== -1 && !team.adviser && row[colAdviser]) {
          team.adviser = String(row[colAdviser]).trim();
        }
      }

      logger.info(`importTeams: Found ${teamMap.size} teams`);

      let teamsCreated = 0;
      let membersCreated = 0;

      for (const [teamCode, teamData] of teamMap) {
        // Extract team number from team code (last 2 digits, e.g. "2526-sem1-it332-01" -> 1)
        const numberMatch = teamCode.match(/(\d{1,2})$/);
        const teamNumber = numberMatch ? parseInt(numberMatch[1], 10) : teamsCreated + 1;

        // Find who is leader (member #1 per the sheet note)
        let leaderName = '';
        for (const row of teamData.rows) {
          const memberNum = colMemberNum !== -1 ? parseInt(String(row[colMemberNum] || '0'), 10) : 0;
          if (memberNum === 1) {
            const fn = colFirstname !== -1 ? String(row[colFirstname] || '').trim() : '';
            const ln = colLastname !== -1 ? String(row[colLastname] || '').trim() : '';
            leaderName = `${fn} ${ln}`.trim();
            break;
          }
        }

        // Upsert team_group  (use team_code for dedup)
        const teamResult = await query(
          `INSERT INTO team_groups (organization_id, team_code, team_number, name, description, adviser_name, leader_name, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
           ON CONFLICT (organization_id, team_number)
           DO UPDATE SET
             team_code = EXCLUDED.team_code,
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             adviser_name = EXCLUDED.adviser_name,
             leader_name = EXCLUDED.leader_name,
             updated_at = NOW()
           RETURNING id, (xmax = 0) AS inserted`,
          [
            sheet.organization_id,
            teamCode,
            teamNumber,
            teamData.project || `Team ${teamNumber}`,
            teamData.project ? `Imported from sheet: ${teamCode}` : null,
            teamData.adviser || null,
            leaderName || null
          ]
        );

        const teamGroupId = teamResult.rows[0].id;
        if (teamResult.rows[0].inserted) teamsCreated++;

        // Insert members
        for (const row of teamData.rows) {
          const memberNum = colMemberNum !== -1 ? parseInt(String(row[colMemberNum] || '0'), 10) : 0;
          const fn = colFirstname !== -1 ? String(row[colFirstname] || '').trim() : '';
          const ln = colLastname !== -1 ? String(row[colLastname] || '').trim() : '';
          const fullName = `${fn} ${ln}`.trim();
          if (!fullName) continue;

          const email = colEmail !== -1 ? String(row[colEmail] || '').trim() : null;
          const studentId = colStudentId !== -1 ? String(row[colStudentId] || '').trim() : null;
          const isLeader = memberNum === 1;

          // First, check if another member in this team already has the new email
          // If so, clear that member's email to avoid unique constraint violation
          if (email) {
            await query(
              `UPDATE team_group_members
               SET email = NULL
               WHERE team_group_id = $1
                 AND email = $2
                 AND member_number != $3`,
              [teamGroupId, email, memberNum]
            );
          }

          await query(
            `INSERT INTO team_group_members (team_group_id, name, email, student_id, member_number, is_leader)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (team_group_id, member_number)
             DO UPDATE SET
               name = EXCLUDED.name,
               email = EXCLUDED.email,
               student_id = EXCLUDED.student_id,
               is_leader = EXCLUDED.is_leader
            `,
            [teamGroupId, fullName, email, studentId, memberNum, isLeader]
          );

          membersCreated++;
        }
      }

      logger.info(`importTeams: Created ${teamsCreated} teams, ${membersCreated} members`);
      return { success: true, teamsCreated, membersCreated };

    } catch (error: any) {
      logger.error('importTeams error:', error);
      return { success: false, teamsCreated: 0, membersCreated: 0, error: error.message };
    }
  }

  /**
   * Recalculate progress for parent tasks up the WBS hierarchy
   */
  async calculateParentProgress(taskId: string): Promise<void> {
    try {
      // 1. Get task information
      const taskResult = await query(
        `SELECT parent_task_id, synced_sheet_id FROM sheet_tasks WHERE id = $1`,
        [taskId]
      );

      if (taskResult.rows.length === 0 || !taskResult.rows[0].parent_task_id) {
        return; // Root task or not found
      }

      const parentId = taskResult.rows[0].parent_task_id;
      const sheetId = taskResult.rows[0].synced_sheet_id;

      // 2. Get all children of this parent
      const childrenResult = await query(
        `SELECT status, progress_percent, complexity_weight FROM sheet_tasks 
         WHERE parent_task_id = $1 AND synced_sheet_id = $2`,
        [parentId, sheetId]
      );

      if (childrenResult.rows.length === 0) return;

      // 3. Calculate weighted average
      let totalWeight = 0;
      let completedWeight = 0;

      for (const child of childrenResult.rows) {
        const weight = child.complexity_weight || 1;
        totalWeight += weight;

        // If status is 'completed' or 'done', we consider it 100%
        if (['completed', 'done'].includes(child.status)) {
          completedWeight += weight;
        } else {
          // Otherwise use the progress_percent
          const progress = child.progress_percent || 0;
          completedWeight += (progress / 100) * weight;
        }
      }

      const totalProgress = Math.round((completedWeight / totalWeight) * 100);

      // 4. Update parent in DB
      await query(
        `UPDATE sheet_tasks SET progress_percent = $1 WHERE id = $2`,
        [totalProgress, parentId]
      );

      // 5. Write parent progress back to Google Sheet
      await this.updateSheetTask(parentId, 'progress', totalProgress.toString() + '%');

      // 6. Recurse up the tree
      await this.calculateParentProgress(parentId);

    } catch (error) {
      logger.error('Error calculating parent progress:', error);
    }
  }
}

export const workspaceSyncService = new WorkspaceSyncService();
