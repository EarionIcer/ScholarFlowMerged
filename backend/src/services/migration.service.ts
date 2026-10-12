import { query } from '../config/database';
import logger from '../config/logger';

/**
 * Auto-migration service that ensures database schema is up to date on startup
 */
export async function runAutoMigrations(): Promise<void> {
  logger.info('🔄 Running auto-migrations...');

  try {
    // Create migrations tracking table if it doesn't exist
    await query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Run base schema setup
    await ensureBaseSchema();

    // Run incremental migrations
    await runMigrations();

    logger.info('✅ Auto-migrations completed successfully');
  } catch (error) {
    logger.error('❌ Auto-migration failed:', error);
    throw error;
  }
}

/**
 * Ensures all base tables and extensions exist
 */
async function ensureBaseSchema(): Promise<void> {
  // Enable UUID extension
  await query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

  // Create organizations table
  await query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(255) NOT NULL,
      description TEXT,
      domain VARCHAR(255),
      logo_url TEXT,
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create users table
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      google_id VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      profile_picture TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_expiry TIMESTAMP,
      onboarding_completed BOOLEAN DEFAULT FALSE,
      onboarding_data JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP
    )
  `);

  // Create organization_members table
  await query(`
    CREATE TABLE IF NOT EXISTS organization_members (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'manager', 'member')),
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'inactive')),
      invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
      invited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      joined_at TIMESTAMP,
      UNIQUE(organization_id, user_id)
    )
  `);

  // Create projects table
  await query(`
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'archived')),
      priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
      start_date DATE,
      end_date DATE,
      budget DECIMAL(15, 2),
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      calendar_id VARCHAR(255),
      drive_folder_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create project_members table
  await query(`
    CREATE TABLE IF NOT EXISTS project_members (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('lead', 'member', 'viewer')),
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE(project_id, user_id)
    )
  `);

  // Create tasks table
  await query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      status VARCHAR(20) DEFAULT 'todo',
      priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
      due_date TIMESTAMP,
      estimated_hours DECIMAL(10, 2),
      actual_hours DECIMAL(10, 2),
      assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    )
  `);

  // Create organization_invitations table
  await query(`
    CREATE TABLE IF NOT EXISTS organization_invitations (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'manager', 'member')),
      token VARCHAR(255) UNIQUE NOT NULL,
      invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
      expires_at TIMESTAMP NOT NULL,
      accepted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(organization_id, email)
    )
  `);

  // Create other essential tables
  await query(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      comment TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS milestones (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      due_date DATE,
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'missed')),
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS drive_files (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      google_drive_id VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(500) NOT NULL,
      mime_type VARCHAR(100),
      size BIGINT,
      web_view_link TEXT,
      web_content_link TEXT,
      thumbnail_link TEXT,
      owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
      project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
      task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
      parent_folder_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      google_event_id VARCHAR(255) UNIQUE NOT NULL,
      calendar_id VARCHAR(255) NOT NULL,
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      location VARCHAR(255),
      start_time TIMESTAMP NOT NULL,
      end_time TIMESTAMP NOT NULL,
      all_day BOOLEAN DEFAULT FALSE,
      event_type VARCHAR(50),
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50),
      entity_id VARCHAR(255),
      details JSONB,
      ip_address INET,
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  logger.info('📦 Base schema verified');
}

/**
 * Run individual migrations that haven't been applied yet
 */
async function runMigrations(): Promise<void> {
  const migrations: { name: string; sql: string }[] = [
    {
      name: '001_add_archived_status',
      sql: `
        DO $$ 
        BEGIN
          ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
          ALTER TABLE tasks ADD CONSTRAINT tasks_status_check 
            CHECK (status IN ('todo', 'in_progress', 'review', 'done', 'completed', 'blocked', 'archived'));
        EXCEPTION
          WHEN others THEN NULL;
        END $$;
      `
    },
    {
      name: '002_add_onboarding_fields',
      sql: `
        ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_data JSONB;
      `
    },
    {
      name: '003_create_indexes',
      sql: `
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id); EXCEPTION WHEN others THEN NULL; END $$;
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_users_email ON users(email); EXCEPTION WHEN others THEN NULL; END $$;
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_organization_members_org_id ON organization_members(organization_id); EXCEPTION WHEN others THEN NULL; END $$;
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_projects_organization_id ON projects(organization_id); EXCEPTION WHEN others THEN NULL; END $$;
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id); EXCEPTION WHEN others THEN NULL; END $$;
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to); EXCEPTION WHEN others THEN NULL; END $$;
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status); EXCEPTION WHEN others THEN NULL; END $$;
      `
    },
    {
      name: '004_fix_missing_columns',
      sql: `
        -- Add organization_id to projects if missing
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
        
        -- Add organization_id to organization_members if missing
        ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
        
        -- Add user_id to organization_members if missing
        ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
      `
    },
    {
      name: '005_fix_projects_columns',
      sql: `
        -- Add all missing columns to projects table
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT;
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium';
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_date DATE;
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_date DATE;
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget DECIMAL(15, 2);
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS calendar_id VARCHAR(255);
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS drive_folder_id VARCHAR(255);
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      `
    },
    {
      name: '006_fix_organizations_columns',
      sql: `
        -- Add created_by to organizations if missing
        ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
      `
    },
    {
      name: '007_add_theme_mode',
      sql: `
        -- Add theme_mode column for UI preference (professional or aviation)
        ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_mode VARCHAR(20) DEFAULT 'professional';
      `
    },
    {
      name: '008_professional_features',
      sql: `
        -- Activity Log for tracking all actions
        CREATE TABLE IF NOT EXISTS activity_log (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          user_name VARCHAR(255),
          action VARCHAR(50) NOT NULL,
          entity_type VARCHAR(50) NOT NULL,
          entity_id UUID,
          entity_name VARCHAR(255),
          details JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Notifications
        CREATE TABLE IF NOT EXISTS notifications (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          type VARCHAR(50) NOT NULL,
          title VARCHAR(255),
          message TEXT,
          task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
          is_read BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Task Comments
        CREATE TABLE IF NOT EXISTS task_comments (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          user_name VARCHAR(255),
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Time Entries
        CREATE TABLE IF NOT EXISTS time_entries (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          user_name VARCHAR(255),
          hours DECIMAL(5,2) NOT NULL,
          date DATE DEFAULT CURRENT_DATE,
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Board Widgets (for customizable charts)
        CREATE TABLE IF NOT EXISTS board_widgets (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
          widget_type VARCHAR(50) NOT NULL,
          title VARCHAR(255),
          config JSONB DEFAULT '{}',
          position INTEGER DEFAULT 0,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Add indexes for performance
        CREATE INDEX IF NOT EXISTS idx_activity_log_org ON activity_log(organization_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
        CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id);
        CREATE INDEX IF NOT EXISTS idx_time_entries_task ON time_entries(task_id);
        CREATE INDEX IF NOT EXISTS idx_widgets_org ON board_widgets(organization_id);
      `
    },
    {
      name: '009_task_followers',
      sql: `
        -- Task followers for comment notifications
        CREATE TABLE IF NOT EXISTS task_followers (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          followed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(task_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_task_followers_task ON task_followers(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_followers_user ON task_followers(user_id);
      `
    },
    {
      name: '010_fix_notifications_task_id',
      sql: `
        -- Add task_id column to notifications if it doesn't exist
        ALTER TABLE notifications ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES tasks(id) ON DELETE CASCADE;
      `
    },
    {
      name: '011_task_assignees',
      sql: `
        -- Task assignees junction table for multi-assignee support
        CREATE TABLE IF NOT EXISTS task_assignees (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
          UNIQUE(task_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON task_assignees(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);

        -- Migrate existing assigned_to data to new table
        INSERT INTO task_assignees (task_id, user_id, assigned_at)
        SELECT id, assigned_to, updated_at
        FROM tasks
        WHERE assigned_to IS NOT NULL
        ON CONFLICT (task_id, user_id) DO NOTHING;
      `
    },
    {
      name: '012_comments_support_sheet_tasks',
      sql: `
        -- Drop the FK constraint on task_comments so it can accept both tasks and sheet_tasks IDs
        DO $$ 
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.table_constraints 
            WHERE constraint_name = 'task_comments_task_id_fkey' 
            AND table_name = 'task_comments'
          ) THEN
            ALTER TABLE task_comments DROP CONSTRAINT task_comments_task_id_fkey;
          END IF;
        END $$;
      `
    },
    {
      name: '013_workspace_sync_tables',
      sql: `
        -- Create workspaces table for Google Drive folder sync
        CREATE TABLE IF NOT EXISTS workspaces (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          root_folder_id VARCHAR(255) NOT NULL,
          root_folder_name VARCHAR(255),
          sync_status VARCHAR(50) DEFAULT 'active',
          sync_error TEXT,
          last_synced_at TIMESTAMP,
          drive_channel_id VARCHAR(255),
          drive_channel_expiry TIMESTAMP,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Create synced_sheets table for Google Sheets connections
        CREATE TABLE IF NOT EXISTS synced_sheets (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
          project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
          team_id UUID,
          sheet_id VARCHAR(255) NOT NULL,
          sheet_name VARCHAR(255) NOT NULL,
          sync_status VARCHAR(50) DEFAULT 'active',
          last_synced_at TIMESTAMP,
          column_mapping JSONB DEFAULT '{}',
          row_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(workspace_id, sheet_id)
        );

        -- Create sheet_tasks table for tasks synced from Google Sheets
        CREATE TABLE IF NOT EXISTS sheet_tasks (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          synced_sheet_id UUID REFERENCES synced_sheets(id) ON DELETE CASCADE,
          project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
          sheet_row_index INTEGER NOT NULL,
          title VARCHAR(500) NOT NULL,
          description TEXT,
          status VARCHAR(50) DEFAULT 'todo',
          priority VARCHAR(20) DEFAULT 'medium',
          due_date TIMESTAMP,
          assignee_email VARCHAR(255),
          synced_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(synced_sheet_id, sheet_row_index)
        );

        -- Indexes for performance
        CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(organization_id);
        CREATE INDEX IF NOT EXISTS idx_synced_sheets_workspace ON synced_sheets(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_sheet_tasks_synced_sheet ON sheet_tasks(synced_sheet_id);
      `
    },
    {
      name: '014_fix_workspace_sync_columns',
      sql: `
        -- Add missing columns to workspaces table
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name = 'sync_error') THEN
            ALTER TABLE workspaces ADD COLUMN sync_error TEXT;
          END IF;
        END $$;

        -- Add missing columns to synced_sheets table
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'synced_sheets' AND column_name = 'project_id') THEN
            ALTER TABLE synced_sheets ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'synced_sheets' AND column_name = 'column_mapping') THEN
            ALTER TABLE synced_sheets ADD COLUMN column_mapping JSONB DEFAULT '{}';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'synced_sheets' AND column_name = 'row_count') THEN
            ALTER TABLE synced_sheets ADD COLUMN row_count INTEGER DEFAULT 0;
          END IF;
        END $$;

        -- Rename task_column_mapping to column_mapping if it exists (and column_mapping doesn't)
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'synced_sheets' AND column_name = 'task_column_mapping')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'synced_sheets' AND column_name = 'column_mapping') THEN
            ALTER TABLE synced_sheets RENAME COLUMN task_column_mapping TO column_mapping;
          END IF;
        END $$;

        -- Add missing columns to sheet_tasks table
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sheet_tasks' AND column_name = 'project_id') THEN
            ALTER TABLE sheet_tasks ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sheet_tasks' AND column_name = 'assignee_email') THEN
            ALTER TABLE sheet_tasks ADD COLUMN assignee_email VARCHAR(255);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sheet_tasks' AND column_name = 'synced_at') THEN
            ALTER TABLE sheet_tasks ADD COLUMN synced_at TIMESTAMP;
          END IF;
        END $$;

        -- Rename assigned_to to assignee_email if it exists (and assignee_email doesn't)
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sheet_tasks' AND column_name = 'assigned_to')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sheet_tasks' AND column_name = 'assignee_email') THEN
            ALTER TABLE sheet_tasks RENAME COLUMN assigned_to TO assignee_email;
          END IF;
        END $$;
      `
    },
    {
      name: '015_ensure_workspace_columns',
      sql: `
        -- Ensure sync_error column exists on workspaces
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name = 'sync_error') THEN
            ALTER TABLE workspaces ADD COLUMN sync_error TEXT;
          END IF;
        END $$;

        -- Ensure column_mapping exists on synced_sheets
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'synced_sheets' AND column_name = 'column_mapping') THEN
            ALTER TABLE synced_sheets ADD COLUMN column_mapping JSONB DEFAULT '{}';
          END IF;
        END $$;

        -- Ensure project_id exists on synced_sheets
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'synced_sheets' AND column_name = 'project_id') THEN
            ALTER TABLE synced_sheets ADD COLUMN project_id UUID;
          END IF;
        END $$;

        -- Ensure row_count exists on synced_sheets
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'synced_sheets' AND column_name = 'row_count') THEN
            ALTER TABLE synced_sheets ADD COLUMN row_count INTEGER DEFAULT 0;
          END IF;
        END $$;

        -- Ensure project_id exists on sheet_tasks
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sheet_tasks' AND column_name = 'project_id') THEN
            ALTER TABLE sheet_tasks ADD COLUMN project_id UUID;
          END IF;
        END $$;

        -- Ensure assignee_email exists on sheet_tasks
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sheet_tasks' AND column_name = 'assignee_email') THEN
            ALTER TABLE sheet_tasks ADD COLUMN assignee_email VARCHAR(255);
          END IF;
        END $$;

        -- Ensure synced_at exists on sheet_tasks
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sheet_tasks' AND column_name = 'synced_at') THEN
            ALTER TABLE sheet_tasks ADD COLUMN synced_at TIMESTAMP;
          END IF;
        END $$;
      `
    },
    {
      name: '016_create_sync_logs',
      sql: `
        CREATE TABLE IF NOT EXISTS sync_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
          event_type VARCHAR(100) NOT NULL,
          event_data JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_sync_logs_workspace ON sync_logs(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_sync_logs_created ON sync_logs(created_at);
      `
    },
    {
      name: '017_add_sync_logs_details',
      sql: `
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sync_logs' AND column_name = 'details') THEN
            ALTER TABLE sync_logs ADD COLUMN details JSONB DEFAULT '{}';
          END IF;
        END $$;
      `
    },
    {
      name: '018_bug_reports',
      sql: `
        CREATE TABLE IF NOT EXISTS bug_reports (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          user_email VARCHAR(255) NOT NULL,
          user_name VARCHAR(255),
          category VARCHAR(50) NOT NULL DEFAULT 'bug' CHECK (category IN ('bug', 'feature', 'feedback', 'other')),
          title VARCHAR(255) NOT NULL,
          description TEXT NOT NULL,
          page_url TEXT,
          status VARCHAR(20) DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'resolved', 'dismissed')),
          creator_notes TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
        CREATE INDEX IF NOT EXISTS idx_bug_reports_created ON bug_reports(created_at DESC);
      `
    },
    {
      name: '019_team_board',
      sql: `
        -- Team Groups: Represents class teams (e.g., IT332 Team 01)
        CREATE TABLE IF NOT EXISTS team_groups (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
          team_code VARCHAR(100),
          team_number INTEGER NOT NULL,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          adviser_id UUID REFERENCES users(id) ON DELETE SET NULL,
          adviser_name VARCHAR(255),
          leader_id UUID REFERENCES users(id) ON DELETE SET NULL,
          leader_name VARCHAR(255),
          source_sheet_id VARCHAR(255),
          status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        -- Team Group Members
        CREATE TABLE IF NOT EXISTS team_group_members (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_group_id UUID REFERENCES team_groups(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          member_number INTEGER NOT NULL,
          name VARCHAR(255) NOT NULL,
          email VARCHAR(255),
          student_id VARCHAR(100),
          is_leader BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(team_group_id, member_number)
        );

        -- Team Checkpoints: Adviser-marked progress items
        CREATE TABLE IF NOT EXISTS team_checkpoints (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_group_id UUID REFERENCES team_groups(id) ON DELETE CASCADE,
          member_id UUID REFERENCES team_group_members(id) ON DELETE SET NULL,
          title VARCHAR(255) NOT NULL,
          description TEXT,
          status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
          due_date TIMESTAMP,
          completed_at TIMESTAMP,
          marked_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        -- Team Comments
        CREATE TABLE IF NOT EXISTS team_comments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_group_id UUID REFERENCES team_groups(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          user_name VARCHAR(255),
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );

        -- Indexes
        CREATE INDEX IF NOT EXISTS idx_team_groups_org ON team_groups(organization_id);
        CREATE INDEX IF NOT EXISTS idx_team_groups_adviser ON team_groups(adviser_id);
        CREATE INDEX IF NOT EXISTS idx_team_group_members_group ON team_group_members(team_group_id);
        CREATE INDEX IF NOT EXISTS idx_team_group_members_user ON team_group_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_team_checkpoints_group ON team_checkpoints(team_group_id);
        CREATE INDEX IF NOT EXISTS idx_team_checkpoints_member ON team_checkpoints(member_id);
        CREATE INDEX IF NOT EXISTS idx_team_comments_group ON team_comments(team_group_id);
      `
    },
    {
      name: '020_team_groups_unique',
      sql: `
        -- Add unique constraint for team import upsert
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'uq_team_groups_org_number'
          ) THEN
            ALTER TABLE team_groups ADD CONSTRAINT uq_team_groups_org_number UNIQUE (organization_id, team_number);
          END IF;
        END $$;
      `
    },
    {
      name: '021_add_progress_column',
      sql: `
        -- Add progress tracking column to team_groups table
        ALTER TABLE team_groups 
        ADD COLUMN IF NOT EXISTS progress DECIMAL(5,2) DEFAULT 0.00 CHECK (progress >= 0 AND progress <= 100);
      `
    },
    {
      name: '022_add_ss_group_id_to_projects',
      sql: `
        -- Add ss_group_id to projects table for ScholarSync mapping
        ALTER TABLE projects 
        ADD COLUMN IF NOT EXISTS ss_group_id UUID;
        
        CREATE INDEX IF NOT EXISTS idx_projects_ss_group_id ON projects(ss_group_id);
      `
    },
    {
      name: '023_progress_sync_trigger',
      sql: `
        -- Function to calculate project progress and send notification
        CREATE OR REPLACE FUNCTION notify_progress_update()
        RETURNS TRIGGER AS $$
        DECLARE
            v_project_id UUID;
            v_ss_group_id UUID;
            v_team_id UUID;
            v_total_tasks INTEGER := 0;
            v_completed_tasks INTEGER := 0;
            v_progress DECIMAL(5,2);
        BEGIN
            -- Get context from the task
            v_project_id := COALESCE(NEW.project_id, OLD.project_id);
            v_team_id := COALESCE(NEW.team_id, OLD.team_id);
            
            -- If no team_id, try to get it from synced_sheets if this is a sheet task
            IF v_team_id IS NULL AND TG_TABLE_NAME = 'sheet_tasks' THEN
                SELECT team_id INTO v_team_id FROM synced_sheets WHERE id = COALESCE(NEW.synced_sheet_id, OLD.synced_sheet_id);
            END IF;

            -- 1. Progress for Project-wide ScholarSync mapping
            SELECT ss_group_id INTO v_ss_group_id FROM projects WHERE id = v_project_id;
            
            -- 2. Team Progress Calculation (if team_id exists)
            IF v_team_id IS NOT NULL THEN
                -- Count regular tasks
                SELECT COUNT(*), COUNT(*) FILTER (WHERE status IN ('done', 'completed', 'Done'))
                INTO v_total_tasks, v_completed_tasks
                FROM tasks WHERE team_id = v_team_id AND status != 'archived';
                
                -- Add internal sheet tasks
                DECLARE
                    vt_sheet_total INTEGER;
                    vt_sheet_done INTEGER;
                BEGIN
                    SELECT COUNT(*), COUNT(*) FILTER (WHERE status IN ('done', 'completed', 'Done'))
                    INTO vt_sheet_total, vt_sheet_done
                    FROM sheet_tasks WHERE team_id = v_team_id;
                    
                    v_total_tasks := v_total_tasks + vt_sheet_total;
                    v_completed_tasks := v_completed_tasks + vt_sheet_done;
                END;

                -- Add checkpoints
                DECLARE
                    v_cp_total INTEGER;
                    v_cp_done INTEGER;
                BEGIN
                    SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'completed')
                    INTO v_cp_total, v_cp_done
                    FROM team_checkpoints WHERE team_group_id = v_team_id;
                    
                    v_total_tasks := v_total_tasks + v_cp_total;
                    v_completed_tasks := v_completed_tasks + v_cp_done;
                END;

                -- Calculate and Update
                IF v_total_tasks > 0 THEN
                    v_progress := ROUND((v_completed_tasks::DECIMAL / v_total_tasks::DECIMAL) * 100, 2);
                ELSE
                    v_progress := 0.00;
                END IF;

                UPDATE team_groups SET progress = v_progress, updated_at = NOW() WHERE id = v_team_id;
            END IF;

            -- 3. ScholarSync Notification (Project-level)
            IF v_ss_group_id IS NOT NULL THEN
                -- Re-calculate project-wide progress if needed
                PERFORM pg_notify('progress_update', json_build_object(
                    'group_id', v_ss_group_id,
                    'project_id', v_project_id,
                    'progress', v_progress,
                    'timestamp', EXTRACT(EPOCH FROM NOW())
                )::text);
            END IF;
            
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        -- Create trigger on tasks table
        DROP TRIGGER IF EXISTS task_progress_update ON tasks;
        CREATE TRIGGER task_progress_update
        AFTER INSERT OR UPDATE OF status OR DELETE ON tasks
        FOR EACH ROW EXECUTE FUNCTION notify_progress_update();
      `
    },
    {
      name: '024_add_team_id_to_synced_sheets',
      sql: `
        -- Add team_id column to synced_sheets for linking sheets to team groups
        ALTER TABLE synced_sheets 
        ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES team_groups(id) ON DELETE SET NULL;

        CREATE INDEX IF NOT EXISTS idx_synced_sheets_team ON synced_sheets(team_id);
      `
    },
    {
      name: '025_add_sheet_tasks_columns',
      sql: `
        -- Add missing columns to sheet_tasks for WBS sync support
        ALTER TABLE sheet_tasks ADD COLUMN IF NOT EXISTS team_id UUID;
        ALTER TABLE sheet_tasks ADD COLUMN IF NOT EXISTS wbs_code VARCHAR(100);
        ALTER TABLE sheet_tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID;
        ALTER TABLE sheet_tasks ADD COLUMN IF NOT EXISTS complexity_weight INTEGER DEFAULT 1;
        ALTER TABLE sheet_tasks ADD COLUMN IF NOT EXISTS is_absolute BOOLEAN DEFAULT FALSE;
        ALTER TABLE sheet_tasks ADD COLUMN IF NOT EXISTS start_date TIMESTAMP;
      `
    },
    {
      name: '026_add_tasks_missing_columns',
      sql: `
        -- Add missing columns to tasks table for WBS sync and filtering
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS team_id UUID;
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_absolute BOOLEAN DEFAULT FALSE;
      `
    },
    {
      name: '027_sheet_tasks_progress_trigger',
      sql: `
        -- Create trigger on sheet_tasks table
        DROP TRIGGER IF EXISTS sheet_task_progress_update ON sheet_tasks;
        CREATE TRIGGER sheet_task_progress_update
        AFTER INSERT OR UPDATE OF status OR DELETE ON sheet_tasks
        FOR EACH ROW EXECUTE FUNCTION notify_progress_update();
      `
    },
    {
      name: '028_fix_synced_sheets_unique_team_sheet',
      sql: `
        -- Ensure each team has a unique sheet mapping and one sheet isn't used by multiple teams
        ALTER TABLE synced_sheets DROP CONSTRAINT IF EXISTS synced_sheets_workspace_id_sheet_id_key;
        
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'synced_sheets_team_sheet_unique') THEN
            ALTER TABLE synced_sheets ADD CONSTRAINT synced_sheets_team_sheet_unique UNIQUE(team_id, sheet_id);
          END IF;
        END $$;
      `
    },
    {
      name: '029_add_luxury_weight_to_tasks',
      sql: `
        -- Add luxury_weight column to both tasks and sheet_tasks for column alignment in UNION queries
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS luxury_weight INTEGER DEFAULT 1;
        ALTER TABLE sheet_tasks ADD COLUMN IF NOT EXISTS luxury_weight INTEGER DEFAULT 1;
        
        -- Update existing records to have a default value
        UPDATE tasks SET luxury_weight = 1 WHERE luxury_weight IS NULL;
        UPDATE sheet_tasks SET luxury_weight = 1 WHERE luxury_weight IS NULL;
      `
    },
    {
      name: '030_equalizer_system',
      sql: `
        -- Index on sheet_tasks.assignee_email for fast Equalizer lookup during login
        CREATE INDEX IF NOT EXISTS idx_sheet_tasks_assignee_email ON sheet_tasks(assignee_email);

        -- Index on organization_invitations.email for fast pending-invite lookup
        CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON organization_invitations(email);

        -- Add invited_email to organization_members for "ghost" pending members
        -- discovered from Google Sheet syncs (no user account yet)
        ALTER TABLE organization_members 
        ADD COLUMN IF NOT EXISTS invited_email VARCHAR(255);

        -- Index for fast email-based lookup during the Equalizer handshake
        CREATE INDEX IF NOT EXISTS idx_org_members_invited_email ON organization_members(invited_email);

        -- Ensure the 'invited' status is valid on organization_members
        -- (existing constraint allows: pending, active, inactive)
        DO $$ BEGIN
          ALTER TABLE organization_members DROP CONSTRAINT IF EXISTS organization_members_status_check;
          ALTER TABLE organization_members ADD CONSTRAINT organization_members_status_check
            CHECK (status IN ('pending', 'active', 'inactive', 'invited'));
        EXCEPTION
          WHEN others THEN NULL;
        END $$;
      `
    },
    {
      name: '031_scholarsync_consultation',
      sql: `
        -- 1. Create Consultation Slots Table
        CREATE TABLE IF NOT EXISTS ss_consultation_slots (
          slot_id SERIAL PRIMARY KEY,
          adviser_id INTEGER NOT NULL REFERENCES ss_account(account_id) ON DELETE CASCADE,
          course_id INTEGER NOT NULL REFERENCES ss_courses(id) ON DELETE CASCADE,
          slot_date DATE NOT NULL,
          start_time TIME NOT NULL,
          end_time TIME NOT NULL,
          slot_type VARCHAR(50) DEFAULT 'FIRST_COME_FIRST_SERVE',
          max_groups INTEGER DEFAULT 2,
          owner_account_id INTEGER REFERENCES ss_account(account_id) ON DELETE SET NULL,
          owner_role VARCHAR(50) DEFAULT 'Adviser',
          google_event_id VARCHAR(255),
          status VARCHAR(20) DEFAULT 'available',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        -- 2. Create Consultation Bookings Table
        CREATE TABLE IF NOT EXISTS ss_consultation_bookings (
          booking_id SERIAL PRIMARY KEY,
          slot_id INTEGER NOT NULL REFERENCES ss_consultation_slots(slot_id) ON DELETE CASCADE,
          group_id INTEGER,
          group_name VARCHAR(255),
          student_email VARCHAR(255),
          status VARCHAR(20) DEFAULT 'pending',
          notes TEXT,
          booked_at TIMESTAMP DEFAULT NOW()
        );

        -- 3. Create Indexes
        CREATE INDEX IF NOT EXISTS idx_ss_consultation_slots_adviser ON ss_consultation_slots(adviser_id);
        CREATE INDEX IF NOT EXISTS idx_ss_consultation_slots_course ON ss_consultation_slots(course_id);
        CREATE INDEX IF NOT EXISTS idx_ss_consultation_slots_date ON ss_consultation_slots(slot_date);
        CREATE INDEX IF NOT EXISTS idx_ss_consultation_bookings_slot ON ss_consultation_bookings(slot_id);
      `
    },
    {
      name: '032_team_health_snapshots',
      sql: `
        -- Daily per-team health snapshots for trend analysis
        CREATE TABLE IF NOT EXISTS team_health_snapshots (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_group_id UUID NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
          organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
          health_score NUMERIC(5,2) NOT NULL,
          classification VARCHAR(30) NOT NULL,
          progress_pct NUMERIC(5,2),
          expected_progress_pct NUMERIC(5,2),
          velocity_7d INTEGER DEFAULT 0,
          velocity_30d INTEGER DEFAULT 0,
          overdue_count INTEGER DEFAULT 0,
          blocked_count INTEGER DEFAULT 0,
          discussions_count INTEGER DEFAULT 0,
          participation_ratio NUMERIC(4,3),
          work_concentration NUMERIC(4,3),
          score_breakdown JSONB,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(team_group_id, snapshot_date)
        );
        CREATE INDEX IF NOT EXISTS idx_health_snapshots_team ON team_health_snapshots(team_group_id, snapshot_date DESC);
        CREATE INDEX IF NOT EXISTS idx_health_snapshots_org ON team_health_snapshots(organization_id, snapshot_date DESC);

        -- Teacher feedback on AI classifications for future tuning
        CREATE TABLE IF NOT EXISTS ai_classification_feedback (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_group_id UUID NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
          organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          classification VARCHAR(30) NOT NULL,
          feedback VARCHAR(20) NOT NULL CHECK (feedback IN ('correct', 'incorrect', 'unsure')),
          notes TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ai_feedback_team ON ai_classification_feedback(team_group_id);
      `
    },
    {
      name: '033_ss_group_course_scope',
      sql: `
        -- Add course_id to ss_group so groups with the same name in different courses are isolated
        ALTER TABLE public.ss_group ADD COLUMN IF NOT EXISTS course_id INTEGER REFERENCES ss_courses(id) ON DELETE SET NULL;

        -- Drop the old global unique constraint on groupName (if still present)
        DO $$ BEGIN
          ALTER TABLE public.ss_group DROP CONSTRAINT IF EXISTS "ss_group_groupName_key";
        EXCEPTION WHEN others THEN NULL;
        END $$;

        -- Add scoped unique index: groupName + course_id (only when course_id is not null)
        CREATE UNIQUE INDEX IF NOT EXISTS ss_group_groupname_courseid_key
          ON public.ss_group ("groupName", course_id)
          WHERE course_id IS NOT NULL;
      `
    },
    {
      name: '034_team_groups_course_id',
      sql: `
        -- Add course_id to team_groups for ScholarSync course scoping
        ALTER TABLE team_groups
          ADD COLUMN IF NOT EXISTS course_id INTEGER REFERENCES ss_courses(id) ON DELETE SET NULL;

        CREATE INDEX IF NOT EXISTS idx_team_groups_course ON team_groups(course_id);
      `
    },
    {
      name: '035_team_group_members_email_unique',
      sql: `
        -- Add UNIQUE(team_group_id, email) so ON CONFLICT(team_group_id, email) works in resync
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'uq_team_group_members_group_email'
          ) THEN
            ALTER TABLE team_group_members
              ADD CONSTRAINT uq_team_group_members_group_email UNIQUE (team_group_id, email);
          END IF;
        END $$;
      `
    },
    {
      name: '036_team_groups_name_course_unique',
      sql: `
        -- Add UNIQUE(name, course_id) so ON CONFLICT(name, course_id) works in ScholarSync sheet import
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'uq_team_groups_name_course'
          ) THEN
            ALTER TABLE team_groups
              ADD CONSTRAINT uq_team_groups_name_course UNIQUE (name, course_id);
          END IF;
        END $$;
      `
    },
    {
      name: '037_drop_dead_tables',
      sql: `
        -- Drop dead duplicate tables confirmed to have zero code references

        -- consultation_slots / consultation_bookings: superseded by ss_consultation_slots / ss_consultation_bookings
        DROP TABLE IF EXISTS consultation_bookings;
        DROP TABLE IF EXISTS consultation_slots;

        -- ss_member_journals: superseded by member_journals (active table used by all routes)
        DROP TABLE IF EXISTS ss_member_journals;

        -- ss_groupings: legacy groupings table, zero code references
        DROP TABLE IF EXISTS ss_groupings;

        -- ss_grouptasks: superseded by tasks + sheet_tasks, zero code references
        DROP TABLE IF EXISTS ss_grouptasks;

        -- activity_logs: dead duplicate; all code uses activity_log (no 's')
        DROP TABLE IF EXISTS activity_logs;
      `
    },
    {
      name: '038_ss_account_user_id_bridge',
      sql: `
        -- Add user_id FK to ss_account to bridge ScholarSync identity with SkyFlow users table
        ALTER TABLE ss_account
          ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

        CREATE INDEX IF NOT EXISTS idx_ss_account_user_id ON ss_account(user_id);

        -- Backfill: link existing ss_account rows to users rows by matching email (case-insensitive)
        UPDATE ss_account sa
        SET user_id = u.id
        FROM users u
        WHERE LOWER(TRIM(sa."accountEmail")) = LOWER(TRIM(u.email))
          AND sa.user_id IS NULL;
      `
    },
    {
      name: '039_ss_consultation_role_sync_trigger',
      sql: `
        -- Function: when ss_account.accountRole changes, cascade to organization_members.role
        CREATE OR REPLACE FUNCTION sync_academic_role_to_org()
        RETURNS TRIGGER AS $$
        DECLARE
          v_org_role VARCHAR(20);
        BEGIN
          -- Map academic role to SkyFlow org role
          v_org_role := CASE LOWER(TRIM(NEW."accountRole"))
            WHEN 'admin'    THEN 'admin'
            WHEN 'advisers' THEN 'manager'
            WHEN 'adviser'  THEN 'manager'
            ELSE                 'member'
          END;

          -- Only update if user_id is set (linked account)
          IF NEW.user_id IS NOT NULL THEN
            UPDATE organization_members
            SET role = v_org_role
            WHERE user_id = NEW.user_id
              AND status = 'active';
          END IF;

          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_sync_academic_role ON ss_account;
        CREATE TRIGGER trg_sync_academic_role
        AFTER UPDATE OF "accountRole" ON ss_account
        FOR EACH ROW
        WHEN (OLD."accountRole" IS DISTINCT FROM NEW."accountRole")
        EXECUTE FUNCTION sync_academic_role_to_org();
      `
    },
    {
      name: '040_ss_consultation_date_to_date',
      sql: `
        -- Safely convert ss_consultation."conDate" from TEXT to DATE
        -- Rows with non-parseable dates will be set to NULL rather than failing
        ALTER TABLE public.ss_consultation
          ALTER COLUMN "conDate" TYPE DATE
          USING (
            CASE
              WHEN "conDate" ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN "conDate"::DATE
              ELSE NULL
            END
          );
      `
    },
    {
      name: '041_create_announcements',
      sql: `
        CREATE TABLE IF NOT EXISTS announcements (
          id          SERIAL PRIMARY KEY,
          message     TEXT        NOT NULL,
          type        VARCHAR(20) NOT NULL DEFAULT 'info',
          is_active   BOOLEAN     NOT NULL DEFAULT true,
          expires_at  TIMESTAMPTZ,
          created_by  TEXT        NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `
    },
    {
      name: '042_announcements_org_scope',
      sql: `
        ALTER TABLE announcements
          ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
      `
    },
    // ─── SDD SkyFlow-ScholarSynch 2.0 Modules ───
    {
      name: '043_task_dependencies',
      sql: `
        CREATE TABLE IF NOT EXISTS task_dependencies (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          dependency_type VARCHAR(20) NOT NULL DEFAULT 'finish_to_start',
          created_by UUID REFERENCES users(id),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE (task_id, depends_on_task_id),
          CHECK (task_id <> depends_on_task_id),
          CHECK (dependency_type IN ('finish_to_start','start_to_start','finish_to_finish','start_to_finish'))
        );
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_task_dependencies_task_id ON task_dependencies(task_id); EXCEPTION WHEN others THEN NULL; END $$;
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id); EXCEPTION WHEN others THEN NULL; END $$;
      `
    },
    {
      name: '044_column_mappings',
      sql: `
        CREATE TABLE IF NOT EXISTS column_mappings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          synced_sheet_id UUID REFERENCES synced_sheets(id) ON DELETE CASCADE,
          project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
          sheet_column VARCHAR(255) NOT NULL,
          kanban_column VARCHAR(100) NOT NULL,
          is_active BOOLEAN DEFAULT true,
          created_by UUID REFERENCES users(id),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE (synced_sheet_id, sheet_column)
        );
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_column_mappings_sheet ON column_mappings(synced_sheet_id); EXCEPTION WHEN others THEN NULL; END $$;
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_column_mappings_project ON column_mappings(project_id); EXCEPTION WHEN others THEN NULL; END $$;
      `
    },
    {
      name: '045_sync_and_conflict_logs',
      sql: `
        CREATE TABLE IF NOT EXISTS sync_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
          organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
          triggered_by UUID REFERENCES users(id),
          status VARCHAR(20) NOT NULL DEFAULT 'success',
          synced_count INTEGER DEFAULT 0,
          error_message TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          CHECK (status IN ('success','failed','rate_limited','in_progress'))
        );
        CREATE TABLE IF NOT EXISTS conflict_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
          project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
          field_name VARCHAR(100) NOT NULL,
          sheet_value TEXT,
          kanban_value TEXT,
          merged_value TEXT,
          resolution VARCHAR(20) NOT NULL,
          resolved_by UUID REFERENCES users(id),
          resolved_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          CHECK (resolution IN ('keep_sheet','keep_kanban','merged'))
        );
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_sync_logs_project ON sync_logs(project_id); EXCEPTION WHEN others THEN NULL; END $$;
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_conflict_logs_task ON conflict_logs(task_id); EXCEPTION WHEN others THEN NULL; END $$;
      `
    },
    {
      name: '046_billing_subscriptions',
      sql: `
        CREATE TABLE IF NOT EXISTS subscriptions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          stripe_customer_id VARCHAR(255),
          stripe_subscription_id VARCHAR(255),
          plan VARCHAR(20) NOT NULL DEFAULT 'free',
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          seat_count INTEGER DEFAULT 5,
          billing_cycle VARCHAR(10) DEFAULT 'monthly',
          current_period_start TIMESTAMP WITH TIME ZONE,
          current_period_end TIMESTAMP WITH TIME ZONE,
          cancel_at_period_end BOOLEAN DEFAULT false,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE (organization_id),
          CHECK (plan IN ('free','standard','pro','enterprise')),
          CHECK (status IN ('active','past_due','canceled','trialing','incomplete')),
          CHECK (billing_cycle IN ('monthly','annual'))
        );
        CREATE TABLE IF NOT EXISTS billing_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
          stripe_event_id VARCHAR(255) UNIQUE,
          event_type VARCHAR(100) NOT NULL,
          amount_cents INTEGER,
          currency VARCHAR(10) DEFAULT 'usd',
          invoice_url TEXT,
          receipt_url TEXT,
          description TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
      `
    },
    {
      name: '047_report_history',
      sql: `
        CREATE TABLE IF NOT EXISTS report_history (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
          organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
          generated_by UUID REFERENCES users(id),
          report_type VARCHAR(50) NOT NULL,
          format VARCHAR(10) NOT NULL DEFAULT 'pdf',
          title VARCHAR(255) NOT NULL,
          sprint_label VARCHAR(100),
          date_range_start DATE,
          date_range_end DATE,
          google_doc_id VARCHAR(255),
          google_doc_url TEXT,
          pdf_url TEXT,
          status VARCHAR(20) DEFAULT 'completed',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          CHECK (format IN ('pdf','google_doc')),
          CHECK (status IN ('pending','completed','failed'))
        );
        DO $$ BEGIN CREATE INDEX IF NOT EXISTS idx_report_history_project ON report_history(project_id); EXCEPTION WHEN others THEN NULL; END $$;
      `
    },
    {
      name: '048_ms365_tokens',
      sql: `
        CREATE TABLE IF NOT EXISTS ms365_tokens (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expires_at TIMESTAMP WITH TIME ZONE,
          scope TEXT,
          ms_user_id VARCHAR(255),
          ms_user_email VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE (user_id, organization_id)
        );
        CREATE TABLE IF NOT EXISTS ms365_sync_configs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id),
          workbook_id VARCHAR(255),
          workbook_name VARCHAR(255),
          worksheet_id VARCHAR(255),
          worksheet_name VARCHAR(255),
          field_mappings JSONB DEFAULT '{}',
          auto_sync_enabled BOOLEAN DEFAULT false,
          sync_interval_minutes INTEGER DEFAULT 60,
          last_synced_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE (project_id)
        );
      `
    },
    {
      name: '049_fix_sync_logs_columns',
      sql: `
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sync_logs' AND column_name = 'project_id') THEN
            ALTER TABLE sync_logs ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
          END IF;
        END $$;
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sync_logs' AND column_name = 'organization_id') THEN
            ALTER TABLE sync_logs ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
          END IF;
        END $$;
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sync_logs' AND column_name = 'triggered_by') THEN
            ALTER TABLE sync_logs ADD COLUMN triggered_by UUID REFERENCES users(id);
          END IF;
        END $$;
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sync_logs' AND column_name = 'status') THEN
            ALTER TABLE sync_logs ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'success';
          END IF;
        END $$;
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sync_logs' AND column_name = 'synced_count') THEN
            ALTER TABLE sync_logs ADD COLUMN synced_count INTEGER DEFAULT 0;
          END IF;
        END $$;
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sync_logs' AND column_name = 'error_message') THEN
            ALTER TABLE sync_logs ADD COLUMN error_message TEXT;
          END IF;
        END $$;
      `
    },
    {
      name: '050_add_adviser_role',
      sql: `
        -- Drop and recreate the role CHECK constraint on organization_members to include 'adviser'
        DO $$ BEGIN
          ALTER TABLE organization_members DROP CONSTRAINT IF EXISTS organization_members_role_check;
          ALTER TABLE organization_members ADD CONSTRAINT organization_members_role_check
            CHECK (role IN ('admin', 'manager', 'member', 'adviser'));
        EXCEPTION WHEN others THEN NULL;
        END $$;

        -- Drop and recreate the role CHECK constraint on organization_invitations to include 'adviser'
        DO $$ BEGIN
          ALTER TABLE organization_invitations DROP CONSTRAINT IF EXISTS organization_invitations_role_check;
          ALTER TABLE organization_invitations ADD CONSTRAINT organization_invitations_role_check
            CHECK (role IN ('admin', 'manager', 'member', 'adviser'));
        EXCEPTION WHEN others THEN NULL;
        END $$;
      `
    },
    {
      name: '051_add_progress_percent_to_tasks',
      sql: `
        -- Add columns missing from tasks table.
        -- These may have been added via raw SQL files (022_kanban_role_enhancements.sql)
        -- but were never tracked in the migration service. Using IF NOT EXISTS for safety.
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress_percent NUMERIC DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS complexity_weight INTEGER DEFAULT 1;
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS wbs_code VARCHAR(100);
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date TIMESTAMP;
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_absolute BOOLEAN DEFAULT FALSE;

        -- Also ensure task_assignees table exists (created in raw SQL file 022)
        CREATE TABLE IF NOT EXISTS task_assignees (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
          UNIQUE(task_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_assignees_task_id ON task_assignees(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_assignees_user_id ON task_assignees(user_id);
      `
    },
    {
      name: '052_sheet_tasks_missing_columns',
      sql: `
        -- workspace.service.ts syncSheet() inserts progress_percent and luxury_weight into
        -- sheet_tasks but these columns were never added to that table (migration 025 only
        -- added complexity_weight, is_absolute, wbs_code, start_date, team_id).
        ALTER TABLE sheet_tasks ADD COLUMN IF NOT EXISTS progress_percent NUMERIC DEFAULT 0;
        ALTER TABLE sheet_tasks ADD COLUMN IF NOT EXISTS luxury_weight INTEGER DEFAULT 1;
      `
    },
    {
      name: '053_unify_roles_remove_overwrite_trigger',
      sql: `
        -- Role unification: SkyFlow (organization_members.role) and ScholarSync
        -- (ss_account.accountRole) are two independent role systems for the SAME
        -- person. Migration 039 added a trigger that OVERWROTE a user's SkyFlow
        -- org role whenever their academic role changed (e.g. an org 'manager'
        -- who is also a ScholarSync 'Student' would silently get demoted to
        -- 'member'). That conflicts with the goal of having both roles unified
        -- and visible together (e.g. "Member & Student", "Admin & Adviser").
        --
        -- Drop the destructive overwrite trigger/function — both roles now
        -- coexist independently and are surfaced together by the API/UI
        -- (see GET /api/organizations/:id/members → academic_role, and
        -- AppLayout.tsx → combinedRoleLabel()).
        DROP TRIGGER IF EXISTS trg_sync_academic_role ON ss_account;
        DROP FUNCTION IF EXISTS sync_academic_role_to_org();
      `
    },
    {
      name: '054_sync_logs_event_type_nullable',
      sql: `
        -- POST /api/sync/trigger has been failing with 500 ("null value in column
        -- 'event_type' of relation 'sync_logs' violates not-null constraint").
        --
        -- Root cause: sync_logs was originally created in migration 016 with an
        -- old workspace-event-log shape — (workspace_id, event_type NOT NULL,
        -- event_data, details) — used by WorkspaceSyncService.logSync(). Migrations
        -- 045/049 layered a SECOND, newer shape onto the SAME table — (project_id,
        -- organization_id, triggered_by, status, synced_count, error_message) —
        -- used by the /sync/trigger and /sync/status routes, because
        -- "CREATE TABLE IF NOT EXISTS sync_logs" was a no-op (the table already
        -- existed). Every INSERT from /sync/trigger omits event_type entirely,
        -- so it always violated the inherited NOT NULL constraint and 500'd.
        --
        -- Fix: relax event_type to nullable. WorkspaceSyncService.logSync() still
        -- always supplies it, so its rows are unaffected; rows written by the
        -- newer /sync/trigger code path (which has no concept of "event type")
        -- can now insert successfully with event_type = NULL.
        ALTER TABLE sync_logs ALTER COLUMN event_type DROP NOT NULL;
      `
    },
    {
      name: '055_ss_courses_classroom_link',
      sql: `
        -- Link an ss_courses row to the Google Classroom course it was imported
        -- from, so POST /api/classroom/import can find-or-create the matching
        -- ScholarSync course and re-sync enrollments on subsequent imports
        -- instead of creating duplicate course rows each time.
        ALTER TABLE ss_courses ADD COLUMN IF NOT EXISTS "classroomCourseId" VARCHAR(255);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_courses_classroom_course_id
          ON ss_courses("classroomCourseId") WHERE "classroomCourseId" IS NOT NULL;
      `
    },
    {
      name: '056_backfill_admin_to_scholarsync',
      sql: `
        -- "If a user is an admin, they are immediately admin for both the
        -- project management and consultation part of the system."
        --
        -- Going forward, becoming an org admin (org creation, role change, or
        -- invitation acceptance) upserts ss_account.accountRole = 'Admin'
        -- (see ssAccountSync.service.ts). This backfills that for users who
        -- were ALREADY an org admin before that sync existed: for every
        -- active organization_members row with role = 'admin', upsert a
        -- matching ss_account row (by email) with accountRole = 'Admin'.
        INSERT INTO ss_account ("accountName", "accountEmail", "accountRole", user_id)
        SELECT DISTINCT COALESCE(u.name, ''), u.email, 'Admin', u.id
        FROM organization_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.role = 'admin' AND om.status = 'active' AND u.email IS NOT NULL
        ON CONFLICT ("accountEmail") DO UPDATE SET "accountRole" = 'Admin', user_id = COALESCE(ss_account.user_id, EXCLUDED.user_id);
      `
    },
    {
      name: '057_ss_consultation_validation_columns',
      sql: `
        ALTER TABLE ss_consultation ADD COLUMN IF NOT EXISTS validation_status VARCHAR(20) DEFAULT 'not_requested';
        ALTER TABLE ss_consultation ADD COLUMN IF NOT EXISTS validation_requested_at TIMESTAMP;
        ALTER TABLE ss_consultation ADD COLUMN IF NOT EXISTS validated_by VARCHAR(255);
        ALTER TABLE ss_consultation ADD COLUMN IF NOT EXISTS validated_at TIMESTAMP;
        ALTER TABLE ss_consultation ADD COLUMN IF NOT EXISTS validation_notes TEXT;
      `
    },
    {
      name: '058_fix_tasks_status_check_include_archived',
      sql: `
        -- Archiving a task (PATCH /api/tasks/:id/status → 'archived', and the
        -- cascade in PUT /api/projects/:id) was returning 500 with a
        -- "tasks_status_check" violation: the raw SQL file
        -- 022_kanban_role_enhancements.sql re-created that CHECK constraint WITHOUT
        -- 'archived' (and without 'done'), overriding the earlier inline
        -- 001_add_archived_status. Re-establish the full status set the app uses.
        --
        -- The DROP runs first and OUTSIDE the guarded block so that even if the
        -- re-ADD somehow fails on a legacy status value, the stale constraint is
        -- gone and archiving is unblocked.
        ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
        DO $$ BEGIN
          ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
            CHECK (status IN ('todo', 'in_progress', 'review', 'done', 'completed', 'blocked', 'on_hold', 'archived'));
        EXCEPTION WHEN others THEN NULL;
        END $$;
      `
    },
    {
      name: '059_org_join_codes',
      sql: `
        CREATE TABLE IF NOT EXISTS org_join_codes (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          code VARCHAR(16) UNIQUE NOT NULL,
          role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'manager', 'member', 'adviser')),
          label VARCHAR(100),
          max_uses INTEGER DEFAULT NULL,
          use_count INTEGER NOT NULL DEFAULT 0,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          expires_at TIMESTAMP DEFAULT NULL,
          is_active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_org_join_codes_code ON org_join_codes(code);
        CREATE INDEX IF NOT EXISTS idx_org_join_codes_org ON org_join_codes(organization_id);
      `
    },
    {
      name: '060_org_join_codes_project_id',
      sql: `
        ALTER TABLE org_join_codes ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
      `
    },
    {
      name: '061_task_assignees_drop_tasks_fk',
      sql: `
        -- task_assignees.task_id was FK-constrained to tasks(id), so inserting an
        -- assignee for a sheet_task (whose id lives in sheet_tasks, not tasks) caused
        -- a FK violation → HTTP 500. Drop the constraint so any UUID can be used as
        -- task_id, matching how sheet_tasks are referenced throughout the app.
        ALTER TABLE task_assignees DROP CONSTRAINT IF EXISTS task_assignees_task_id_fkey;
      `
    },
    {
      name: '062_drop_task_id_fk_from_followers_and_notifications',
      sql: `
        -- task_followers.task_id and notifications.task_id both REFERENCE tasks(id).
        -- When a sheet_task UUID is used as task_id (e.g. assigning a member or
        -- posting a comment on a sheet task), these FK constraints cause HTTP 500.
        -- Drop them so any UUID works, matching the intent of sheet_tasks support.
        ALTER TABLE task_followers DROP CONSTRAINT IF EXISTS task_followers_task_id_fkey;
        ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_task_id_fkey;
      `
    },
    {
      name: '063_deduplicate_synced_sheets_no_team',
      sql: `
        -- Migration 028 dropped UNIQUE(workspace_id, sheet_id) and kept only
        -- UNIQUE(team_id, sheet_id). When team_id IS NULL, PostgreSQL treats
        -- (NULL, 'sheetX') as distinct from every other (NULL, 'sheetX') — NULLs
        -- are never equal in unique constraints — so the same sheet imported
        -- multiple times creates duplicate synced_sheets rows, each spawning their
        -- own sheet_tasks rows, causing duplicates in the task list.
        --
        -- Fix: keep the most-recently-created row per (workspace_id, sheet_id)
        -- where team_id IS NULL, then add a partial unique index to prevent
        -- future duplicates without touching the team-based uniqueness rule.

        -- 1. Delete older duplicate rows (cascade deletes their sheet_tasks)
        DELETE FROM synced_sheets
        WHERE team_id IS NULL
          AND id NOT IN (
            SELECT DISTINCT ON (workspace_id, sheet_id) id
            FROM synced_sheets
            WHERE team_id IS NULL
            ORDER BY workspace_id, sheet_id, created_at DESC NULLS LAST
          );

        -- 2. Partial unique index: one (workspace_id, sheet_id) per NULL-team sheet
        CREATE UNIQUE INDEX IF NOT EXISTS idx_synced_sheets_ws_sheet_no_team
        ON synced_sheets(workspace_id, sheet_id)
        WHERE team_id IS NULL;
      `
    }
  ];

  for (const migration of migrations) {
    const applied = await query(
      'SELECT 1 FROM _migrations WHERE name = $1',
      [migration.name]
    );

    if (applied.rows.length === 0) {
      logger.info(`  📝 Applying migration: ${migration.name}`);
      await query(migration.sql);
      await query(
        'INSERT INTO _migrations (name) VALUES ($1)',
        [migration.name]
      );
    }
  }
}
