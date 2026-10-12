"use client"

import { API_URL } from '@/lib/api/client'
import { getTodayLocalDateString } from '@/lib/utils/date'
import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { CheckSquare, Plus, Search, LayoutGrid, Table, X, Calendar, AlertCircle, User, Users, Edit3, Archive, RotateCcw, ChevronDown, ChevronRight, FileText, Link2 } from "lucide-react"
import ProfessionalTaskCard from "./ProfessionalTaskCard"
import ProfessionalKanban from "./ProfessionalKanban"
import DependencyDialog from "./DependencyDialog"
import TaskTimeline from "./TaskTimeline"
import MultiAssigneeSelect from "./MultiAssigneeSelect"
import DescriptionEditor from "./DescriptionEditor"
import RecycleTasksModal from "./RecycleTasksModal"
import GoogleSheetImportModal from "./GoogleSheetImportModal"
import TeamSelector from "../shared/TeamSelector"
import { FileSpreadsheet, ShieldCheck } from "lucide-react"

interface Task {
  id: string
  title: string
  description: string
  status: 'todo' | 'in-progress' | 'review' | 'done' | 'archived'
  priority: 'low' | 'medium' | 'high'
  assigned_to: string | null
  assigned_to_name?: string
  assignees?: { user_id: string, name: string }[]
  due_date: string | null
  start_date?: string | null
  is_absolute?: boolean
  complexity_weight?: number
  wbs_code?: string
  parent_task_id?: string | null
  created_at: string
  project_id: string | null
  project_name?: string
  synced?: boolean
  sheet_name?: string
  comment_count?: number
}

interface Member {
  user_id: string
  name: string
  email: string
}

interface ManagerTaskViewProps {
  user: any
  organization: {
    id: string
    name: string
    role: string
  }
  initialProjectId?: string | null
}

export default function ManagerTaskView({ user, organization, initialProjectId = null }: ManagerTaskViewProps) {
  const router = useRouter()
  const [tasks, setTasks] = useState<Task[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [filterPriority, setFilterPriority] = useState<string>("all")
  const [viewMode, setViewMode] = useState<'board' | 'table'>('board')
  const [isArchiveExpanded, setIsArchiveExpanded] = useState(false)
  const [boardSubView, setBoardSubView] = useState<'team' | 'advisor'>('team')
  const [newTask, setNewTask] = useState({
    title: '',
    description: '',
    priority: 'medium' as 'low' | 'medium' | 'high',
    due_date: '',
    start_date: '',
    complexity_weight: 1,
    is_absolute: false,
    wbs_code: '',
    parent_task_id: null as string | null,
    project_id: null as string | null
  })
  const [projects, setProjects] = useState<{id: string; name: string}[]>([])
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [members, setMembers] = useState<Member[]>([])
  const [isGoogleSyncModalOpen, setIsGoogleSyncModalOpen] = useState(false)
  const [dependencyTask, setDependencyTask] = useState<Task | null>(null)
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialProjectId)
  const [showCompleted, setShowCompleted] = useState(false)
  const [completedCount, setCompletedCount] = useState<number>(0)
  const ARCHIVE_PAGE_SIZE = 12
  const [archiveOffset, setArchiveOffset] = useState(0)
  const [archiveTasks, setArchiveTasks] = useState<Task[]>([])
  const [archiveHasMore, setArchiveHasMore] = useState(false)
  const [isArchiveLoading, setIsArchiveLoading] = useState(false)
  const [selectedArchiveIds, setSelectedArchiveIds] = useState<string[]>([])
  const [isRecycleOpen, setIsRecycleOpen] = useState(false)

  const toggleArchiveSelection = (taskId: string) => {
    setSelectedArchiveIds(prev =>
      prev.includes(taskId) ? prev.filter(id => id !== taskId) : [...prev, taskId]
    )
  }

  useEffect(() => {
    fetchTasks()
    fetchCompletedCount()
    fetchMembers()
    fetchProjects()
  }, [organization.id, selectedTeam, selectedProjectId, showCompleted])

  useEffect(() => {
    if (isArchiveExpanded) fetchArchivedTasks(0, false)
  }, [isArchiveExpanded, organization.id, selectedTeam, selectedProjectId])

  const fetchProjects = async () => {
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`${API_URL}/api/projects?organization_id=${organization.id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      if (response.ok) {
        const data = await response.json()
        setProjects(Array.isArray(data) ? data : [])
      }
    } catch (error) {
      console.error('Error fetching projects:', error)
    }
  }

  const fetchTasks = async () => {
    try {
      const token = localStorage.getItem('token')
      const params = new URLSearchParams()
      if (selectedTeam) params.set('team_id', selectedTeam)
      if (selectedProjectId) params.set('project_id', selectedProjectId)
      if (!showCompleted) params.set('exclude_status', 'done,completed,archived')
      const qs = params.toString()
      const url = `${API_URL}/api/organizations/${organization.id}/tasks${qs ? `?${qs}` : ''}`

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (response.ok) {
        const data = await response.json()
        const normalizedTasks = (data.tasks || []).map((task: Task) => ({
          ...task,
          status: normalizeStatus(task.status)
        }))
        setTasks(normalizedTasks)
      }
    } catch (error) {
      console.error('Error fetching tasks:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const fetchCompletedCount = async () => {
    try {
      const token = localStorage.getItem('token')
      const params = new URLSearchParams()
      if (selectedTeam) params.set('team_id', selectedTeam)
      if (selectedProjectId) params.set('project_id', selectedProjectId)
      params.set('status', 'done,completed,archived')
      params.set('limit', '200')
      const response = await fetch(
        `${API_URL}/api/organizations/${organization.id}/tasks?${params.toString()}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      )
      if (response.ok) {
        const data = await response.json()
        setCompletedCount((data.tasks || []).length)
      }
    } catch (error) {
      console.error('Error fetching completed count:', error)
    }
  }

  const fetchArchivedTasks = async (offset: number, append: boolean) => {
    setIsArchiveLoading(true)
    try {
      const token = localStorage.getItem('token')
      const params = new URLSearchParams()
      if (selectedTeam) params.set('team_id', selectedTeam)
      if (selectedProjectId) params.set('project_id', selectedProjectId)
      params.set('status', 'archived')
      params.set('limit', String(ARCHIVE_PAGE_SIZE))
      params.set('offset', String(offset))
      const response = await fetch(
        `${API_URL}/api/organizations/${organization.id}/tasks?${params.toString()}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      )
      if (response.ok) {
        const data = await response.json()
        const normalized = (data.tasks || []).map((task: Task) => ({
          ...task,
          status: normalizeStatus(task.status)
        }))
        setArchiveTasks(prev => append ? [...prev, ...normalized] : normalized)
        setArchiveHasMore(normalized.length === ARCHIVE_PAGE_SIZE)
        setArchiveOffset(offset)
      }
    } finally {
      setIsArchiveLoading(false)
    }
  }

  const normalizeStatus = (status: string): Task['status'] => {
    const statusMap: Record<string, Task['status']> = {
      'in_progress': 'in-progress',
      'in-progress': 'in-progress',
      'in progress': 'in-progress',
      'todo': 'todo',
      'review': 'review',
      'done': 'done',
      'completed': 'done',
      'archived': 'archived'
    }
    return statusMap[status] || status as Task['status']
  }

  const fetchMembers = async () => {
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`${API_URL}/api/organizations/${organization.id}/members`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      if (response.ok) {
        const data = await response.json()
        // Backend returns 'id' (users.id) not 'user_id' — map it so MultiAssigneeSelect works
        const allMembers: Member[] = (data.members || []).map((m: any) => ({
          user_id: m.id,
          name: m.name,
          email: m.email,
          profile_picture: m.profile_picture
        }))

        if (selectedTeam) {
          // Fetch team detail to get team-specific members
          const teamRes = await fetch(`${API_URL}/api/team-groups/${selectedTeam}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          })
          if (teamRes.ok) {
            const teamData = await teamRes.json()
            const teamEmails = new Set(
              (teamData.members || []).map((m: any) => m.email?.toLowerCase()).filter(Boolean)
            )
            const filtered = allMembers.filter(m => teamEmails.has(m.email?.toLowerCase()))
            setMembers(filtered)
            return
          }
        }

        setMembers(allMembers)
      }
    } catch (error) {
      console.error('Error fetching members:', error)
    }
  }

  const handleCreateTask = async () => {
    // Project is required — a task must belong to a specific project.
    if (!newTask.project_id) {
      setCreateError('Please choose a project for this task.')
      return
    }

    // Start date must comply with "latest date is today" — block creation
    // entirely (rather than silently dropping/clearing the date) when violated.
    if (newTask.start_date && newTask.start_date > getTodayLocalDateString()) {
      alert('Start date cannot be later than today.')
      return
    }

    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`${API_URL}/api/organizations/${organization.id}/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          ...newTask,
          due_date: newTask.due_date || null,
          start_date: newTask.start_date || null,
          status: 'todo',
          team_id: selectedTeam
        })
      })
      if (response.ok) {
        setNewTask({
          title: '',
          description: '',
          priority: 'medium',
          due_date: '',
          start_date: '',
          complexity_weight: 1,
          is_absolute: false,
          wbs_code: '',
          parent_task_id: null,
          project_id: null
        })
        setIsCreateModalOpen(false)
        setCreateError(null)
        fetchTasks()
      } else {
        const err = await response.json().catch(() => ({}))
        setCreateError(err.error || `Failed to create task (${response.status})`)
      }
    } catch (error) {
      console.error('Error creating task:', error)
      setCreateError('Network error — please try again')
    }
  }

  const handleStatusChange = async (taskId: string, newStatus: string) => {
    // Optimistic update
    const taskToUpdate = tasks.find(t => t.id === taskId)
    if (!taskToUpdate) return

    const previousTasks = [...tasks]
    const updatedTasks = tasks.map(t => 
      t.id === taskId ? { ...t, status: normalizeStatus(newStatus) as any } : t
    )
    setTasks(updatedTasks)

    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`${API_URL}/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: newStatus })
      })

      if (!response.ok) {
        // Revert on failure
        setTasks(previousTasks)
        const errorData = await response.json()
        alert(errorData.error || 'Failed to update task status')
      } else {
        // Refresh to sync any other changes
        fetchTasks()
      }
    } catch (error) {
      console.error('Error updating status:', error)
      setTasks(previousTasks)
    }
  }

  const handleEditTask = (task: Task) => {
    setEditingTask(task)
    setIsEditModalOpen(true)
  }

  const handleDeleteTask = async (taskId: string) => {
    const taskToDelete = tasks.find(t => t.id === taskId)
    
    // Check if it's a synced task
    const isSynced = taskToDelete && ((taskToDelete as any).source_type === 'sheet' || (taskToDelete as any).google_sheet_id)

    if (isSynced) {
      alert('This task is synced from Google Sheets. To delete it, please remove it from the source Google Sheet. It will then be removed from ScholarFlow upon the next synchronization.')
      return
    }

    if (!confirm('Are you sure you want to delete this task?')) return

    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`${API_URL}/api/tasks/${taskId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (response.ok) {
        // Optimistic UI update
        setTasks(tasks.filter(t => t.id !== taskId))
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to delete task')
      }
    } catch (error) {
      console.error('Error deleting task:', error)
      alert('Network error while deleting task')
    }
  }

  const handleArchiveTask = async (taskId: string) => {
    try {
      const token = localStorage.getItem('token')
      await fetch(`${API_URL}/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: 'archived' })
      })

      fetchTasks()
    } catch (error) {
      console.error('Error archiving task:', error)
    }
  }

  const handleUpdateTask = async () => {
    if (!editingTask) return

    // Start date must comply with "latest date is today" — block the update
    // entirely (rather than silently dropping/clearing the date) when violated.
    const editStartDate = editingTask.start_date ? editingTask.start_date.split('T')[0] : ''
    if (editStartDate && editStartDate > getTodayLocalDateString()) {
      alert('Start date cannot be later than today.')
      return
    }

    try {
      const token = localStorage.getItem('token')
      // Derive assignee fields from the current MultiAssigneeSelect state
      const currentAssigneeIds = (editingTask.assignees || []).map((a: any) => a.user_id).filter(Boolean)
      const primaryAssignee = currentAssigneeIds[0] || null
      const response = await fetch(`${API_URL}/api/tasks/${editingTask.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          title: editingTask.title,
          description: editingTask.description,
          priority: editingTask.priority,
          due_date: editingTask.due_date || null,
          start_date: editingTask.start_date || null,
          complexity_weight: editingTask.complexity_weight,
          is_absolute: editingTask.is_absolute,
          wbs_code: editingTask.wbs_code,
          assigned_to: primaryAssignee,
          assigned_to_ids: currentAssigneeIds
        })
      })
      if (response.ok) {
        setIsEditModalOpen(false)
        setEditingTask(null)
        fetchTasks()
        // Archived tasks are excluded from fetchTasks(), so refresh the archive
        // grid too — otherwise edits to an archived task appear to have no effect.
        if (isArchiveExpanded) fetchArchivedTasks(0, false)
      } else {
        const errData = await response.json().catch(() => ({}))
        alert(`Failed to save task: ${errData.error || response.status}`)
      }
    } catch (error) {
      console.error('Error updating task:', error)
      alert('Failed to save task. Please try again.')
    }
  }

  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData('taskId', taskId)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = async (e: React.DragEvent, newStatus: Task['status']) => {
    e.preventDefault()
    const taskId = e.dataTransfer.getData('taskId')
    await handleStatusChange(taskId, newStatus)
  }

  const getStatusColumn = (status: Task['status']) => {
    return tasks.filter(task => {
      const matchesStatus = task.status === status
      const matchesSearch = task.title.toLowerCase().includes(searchQuery.toLowerCase())
      return matchesStatus && matchesSearch
    })
  }

  const columns = [
    { id: 'todo', title: '📋 To Do' },
    { id: 'in-progress', title: '🔄 In Progress' },
    { id: 'review', title: '👀 Review' },
    { id: 'done', title: '✅ Done' }
  ]

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col pt-4">
      {/* Header Area */}
      <div className="flex flex-col gap-4 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
              Task Management
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              Manage tasks in {organization.name}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <TeamSelector 
              organizationId={organization.id} 
              selectedTeamId={selectedTeam}
              onTeamChange={setSelectedTeam}
              userRole={organization.role as 'admin' | 'manager' | 'member'}
            />
            {/* View Toggle */}
            <div className="flex bg-white/70 dark:bg-slate-800/70 backdrop-blur-sm shadow-sm rounded-xl border border-gray-200 dark:border-slate-700 p-1">
              <button
                onClick={() => setViewMode('board')}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${viewMode === 'board'
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-slate-700/50'
                  }`}
                title="Board View"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                onClick={() => setViewMode('table')}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${viewMode === 'table'
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-slate-700/50'
                  }`}
                title="Table View"
              >
                <Table className="w-4 h-4" />
              </button>
            </div>

            <button
              onClick={() => setIsGoogleSyncModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-800/90 border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-gray-200 rounded-xl hover:bg-gray-50 dark:hover:bg-slate-800 transition-all shadow-sm"
              title="Sync tasks from Google Sheet"
            >
              <FileSpreadsheet className="w-5 h-5 text-green-500" />
              <span className="font-medium">Sync Google Sheet</span>
            </button>

            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all shadow-md hover:shadow-lg"
            >
              <Plus className="w-5 h-5" />
              <span className="font-medium">New Task</span>
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative max-w-md flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-gray-500" />
            <input
              type="text"
              placeholder="Search tasks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-white/70 dark:bg-slate-800/70 backdrop-blur-sm border border-gray-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-400 dark:text-white"
            />
          </div>
          <select
            value={selectedProjectId || 'all'}
            onChange={(e) => setSelectedProjectId(e.target.value === 'all' ? null : e.target.value)}
            className="px-4 py-2 bg-white/70 dark:bg-slate-800/70 backdrop-blur-sm border border-gray-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-400 dark:text-white"
          >
            <option value="all">All Projects</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button
            onClick={() => setShowCompleted(!showCompleted)}
            className={`px-4 py-2 rounded-xl border text-sm font-medium transition-all ${
              showCompleted
                ? 'bg-indigo-500 text-white border-indigo-500'
                : 'bg-white/70 dark:bg-slate-800/70 border-gray-200 dark:border-slate-700 text-gray-600 dark:text-gray-300'
            }`}
          >
            {showCompleted ? 'Hide completed' : `Show completed (${completedCount}${completedCount >= 200 ? '+' : ''})`}
          </button>
        </div>
      </div>

      {/* Board View */}
      {viewMode === 'board' && (
        <div className="space-y-6">
          {/* Board Toggle */}
          <div className="flex bg-indigo-50 dark:bg-indigo-900/20 rounded-xl border border-indigo-200 dark:border-indigo-800/50 p-1 w-fit mb-6">
            <button
              onClick={() => setBoardSubView('team')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${boardSubView === 'team'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'text-indigo-700 hover:bg-indigo-100 dark:text-indigo-400 dark:hover:bg-indigo-900/50'
                }`}
            >
              <Users className="w-4 h-4" />
              Team Board
            </button>
            <button
              onClick={() => setBoardSubView('advisor')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${boardSubView === 'advisor'
                ? 'bg-amber-600 text-white shadow-md'
                : 'text-amber-700 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-900/50'
                }`}
            >
              <ShieldCheck className="w-4 h-4" />
              Advisor Board
            </button>
          </div>

          {boardSubView === 'advisor' ? (
            /* === ADVISOR MASTER BOARD (Absolute Tasks) === */
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-100 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700/50 rounded-full">
                  <ShieldCheck className="w-4 h-4 text-amber-700 dark:text-amber-400" />
                  <span className="text-sm font-bold text-amber-700 dark:text-amber-400">Advisor Master Board</span>
                  <span className="text-xs bg-amber-500 text-white rounded-full px-2 py-0.5">
                    {tasks.filter(t => t.is_absolute && t.status !== 'archived').length}
                  </span>
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500 font-medium">Synced and administrative tasks — Locked for regular members</p>
              </div>
              <ProfessionalKanban
                tasks={tasks.filter(t => t.is_absolute && t.status !== 'archived') as any}
                onTaskClick={(task) => handleEditTask(task as Task)}
                onAddTask={() => setIsCreateModalOpen(true)}
                onStatusChange={handleStatusChange}
                onDeleteTask={handleDeleteTask}
                onArchiveTask={handleArchiveTask}
                onDependency={(task) => setDependencyTask(task as Task)}
                theme="admin"
                role="manager"
              />
            </div>
          ) : (
            /* === TEAM BOARD (Regular Tasks) === */
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-100 dark:bg-indigo-900/40 border border-indigo-300 dark:border-indigo-700/50 rounded-full">
                  <Users className="w-4 h-4 text-indigo-700 dark:text-indigo-400" />
                  <span className="text-sm font-bold text-indigo-700 dark:text-indigo-400">Team Board</span>
                  <span className="text-xs bg-indigo-500 text-white rounded-full px-2 py-0.5">
                    {tasks.filter(t => !t.is_absolute && t.status !== 'archived').length}
                  </span>
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500 font-medium">Internal tasks that team members can freely manage</p>
              </div>
              <ProfessionalKanban
                tasks={tasks.filter(t => !t.is_absolute && t.status !== 'archived') as any}
                onTaskClick={(task) => handleEditTask(task as Task)}
                onAddTask={() => setIsCreateModalOpen(true)}
                onStatusChange={handleStatusChange}
                onDeleteTask={handleDeleteTask}
                onArchiveTask={handleArchiveTask}
                onDependency={(task) => setDependencyTask(task as Task)}
                theme="manager"
                role="manager"
              />
            </div>
          )}
        </div>
      )}

      {/* Archived Section */}
      <div className="mt-8">
        <button
          onClick={() => setIsArchiveExpanded(!isArchiveExpanded)}
          className="flex items-center gap-3 w-full text-left p-4 bg-white/50 dark:bg-slate-800/50 backdrop-blur-sm rounded-xl border border-gray-200 dark:border-slate-700 hover:bg-white/70 dark:hover:bg-slate-800/70 transition-colors"
        >
          {isArchiveExpanded ? (
            <ChevronDown className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          ) : (
            <ChevronRight className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          )}
          <Archive className="w-5 h-5 text-amber-500" />
          <span className="font-semibold text-gray-700 dark:text-gray-200">
            📦 Archived Tasks
          </span>
          <span className="text-sm text-gray-500 dark:text-gray-400 ml-2">
            ({archiveTasks.length}{archiveHasMore ? '+' : ''} {archiveTasks.length === 1 ? 'task' : 'tasks'})
          </span>
        </button>

        {isArchiveExpanded && (
          <>
            {archiveTasks.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 p-3 bg-indigo-50/50 dark:bg-indigo-900/20 rounded-xl border border-indigo-100 dark:border-indigo-800/50">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() =>
                      setSelectedArchiveIds(
                        selectedArchiveIds.length === archiveTasks.length ? [] : archiveTasks.map(t => t.id)
                      )
                    }
                    className="text-xs font-medium text-indigo-600 dark:text-indigo-300 hover:underline"
                  >
                    {selectedArchiveIds.length === archiveTasks.length ? 'Clear selection' : 'Select all'}
                  </button>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{selectedArchiveIds.length} selected</span>
                </div>
                <button
                  onClick={() => setIsRecycleOpen(true)}
                  disabled={selectedArchiveIds.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-500 to-violet-500 text-white rounded-xl text-sm font-medium disabled:opacity-50 hover:from-indigo-600 hover:to-violet-600 transition-all"
                >
                  <RotateCcw className="w-4 h-4" /> Recycle to new project
                </button>
              </div>
            )}
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {archiveTasks.map((task) => (
                <div key={task.id} className="relative">
                  <div className="absolute top-2 left-2 z-20">
                    <input
                      type="checkbox"
                      checked={selectedArchiveIds.includes(task.id)}
                      onChange={() => toggleArchiveSelection(task.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-5 h-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer shadow"
                      title="Select for recycling"
                    />
                  </div>
                  <div className="absolute top-2 right-2 z-20">
                    <button
                      onClick={() => { handleStatusChange(task.id, 'todo'); setArchiveTasks(prev => prev.filter(t => t.id !== task.id)) }}
                      className="p-1.5 bg-indigo-500 hover:bg-blue-600 rounded-lg shadow-md transition-all"
                      title="Restore to Todo"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-white" />
                    </button>
                  </div>
                  <div className="opacity-70 grayscale hover:opacity-100 hover:grayscale-0 transition-all duration-300">
                    <ProfessionalTaskCard
                      task={task as any}
                      onClick={() => handleEditTask(task)}
                      onDelete={handleDeleteTask}
                      onArchive={handleArchiveTask}
                    />
                  </div>
                </div>
              ))}
            </div>
            {archiveTasks.length === 0 && !isArchiveLoading && (
              <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-4">No archived tasks.</p>
            )}
            {archiveHasMore && (
              <div className="mt-4 flex justify-center">
                <button
                  onClick={() => fetchArchivedTasks(archiveOffset + ARCHIVE_PAGE_SIZE, true)}
                  disabled={isArchiveLoading}
                  className="px-4 py-2 bg-white/70 dark:bg-slate-800/70 border border-gray-200 dark:border-slate-700 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
                >
                  {isArchiveLoading ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Table View */}
      {viewMode === 'table' && (
        <div className="bg-white/70 dark:bg-slate-800/70 backdrop-blur-xl rounded-2xl border border-white/40 dark:border-slate-700 shadow-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gradient-to-r from-indigo-500 to-violet-500">
              <tr>
                <th className="px-6 py-4 text-left text-xs font-bold text-white uppercase">Task</th>
                <th className="px-6 py-4 text-left text-xs font-bold text-white uppercase">Status</th>
                <th className="px-6 py-4 text-left text-xs font-bold text-white uppercase">Priority</th>
                <th className="px-6 py-4 text-left text-xs font-bold text-white uppercase">Due Date</th>
                <th className="px-6 py-4 text-left text-xs font-bold text-white uppercase">Assignee</th>
                <th className="px-6 py-4 text-left text-xs font-bold text-white uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
              {tasks.filter(t => t.status !== 'archived').map((task) => (
                <tr key={task.id} className="hover:bg-indigo-50/50 dark:hover:bg-slate-700/50 cursor-pointer" onClick={() => handleEditTask(task)}>
                  <td className="px-6 py-4 font-medium text-gray-800 dark:text-gray-100">{task.title}</td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${task.status === 'done' ? 'bg-green-100 text-green-700' :
                      task.status === 'review' ? 'bg-yellow-100 text-yellow-700' :
                        task.status === 'in-progress' ? 'bg-blue-100 text-blue-700' :
                          'bg-gray-100 text-gray-700'
                      }`}>
                      {task.status.replace('-', ' ')}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${task.priority === 'high' ? 'bg-red-100 text-red-700' :
                      task.priority === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                        'bg-green-100 text-green-700'
                      }`}>
                      {task.priority === 'high' ? 'High' : task.priority === 'medium' ? 'Medium' : 'Low'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-300">
                    {task.due_date ? new Date(task.due_date).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-300">
                    {task.assigned_to_name || 'Unassigned'}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEditTask(task); }}
                        className="p-1 hover:bg-blue-100 rounded-lg transition-colors"
                        title="Edit task"
                      >
                        <Edit3 className="w-4 h-4 text-indigo-600" />
                      </button>
                      {task.project_id && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setDependencyTask(task); }}
                          className="p-1 hover:bg-sky-100 rounded-lg transition-colors"
                          title="Manage Dependencies"
                        >
                          <Link2 className="w-4 h-4 text-sky-500" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tasks.length === 0 && (
            <div className="text-center py-12">
              <CheckSquare className="w-12 h-12 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
              <p className="text-gray-600 dark:text-gray-300">No tasks yet</p>
            </div>
          )}
        </div>
      )}

      {/* Create Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl rounded-2xl shadow-2xl max-w-lg w-full p-6 border dark:border-slate-700">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
                📋 Create New Task
              </h2>
              <button onClick={() => { setIsCreateModalOpen(false); setCreateError(null); }} className="p-2 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                  Task Title
                </label>
                <input
                  type="text"
                  value={newTask.title}
                  onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-indigo-400 dark:bg-slate-800/70 dark:text-white"
                  placeholder="Enter task title"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Description</label>
                <DescriptionEditor
                  value={newTask.description}
                  onChange={(description) => setNewTask({ ...newTask, description })}
                  placeholder="Describe the task, or use “Fill from file” to import from a .txt/.md/.csv/.docx/.pdf"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                    Priority
                  </label>
                  <select
                    value={newTask.priority}
                    onChange={(e) => setNewTask({ ...newTask, priority: e.target.value as any })}
                    className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl dark:bg-slate-800/70 dark:text-white"
                  >
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Due Date</label>
                  <input
                    type="date"
                    value={newTask.due_date}
                    min={getTodayLocalDateString()}
                    onChange={(e) => setNewTask({ ...newTask, due_date: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl dark:bg-slate-800/70 dark:text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Start Date</label>
                  <input
                    type="date"
                    value={newTask.start_date}
                    max={getTodayLocalDateString()}
                    onChange={(e) => setNewTask({ ...newTask, start_date: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl dark:bg-slate-800/70 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Weight (Complexity)</label>
                  <input
                    type="number"
                    value={newTask.complexity_weight}
                    min="1"
                    max="13"
                    onChange={(e) => setNewTask({ ...newTask, complexity_weight: parseInt(e.target.value) || 1 })}
                    className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl dark:bg-slate-800/70 dark:text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Parent Task (Optional)</label>
                <select
                  value={newTask.parent_task_id || ''}
                  onChange={(e) => setNewTask({ ...newTask, parent_task_id: e.target.value || null })}
                  className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl dark:bg-slate-800/70 dark:text-white"
                >
                  <option value="">No Parent (Root Task)</option>
                  {tasks.filter(t => t.status !== 'archived' && (t as any).source_type === 'sheet').map(t => (
                    <option key={t.id} value={t.id}>{t.wbs_code ? `${t.wbs_code} — ` : ''}{t.title}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                  Project <span className="text-red-500">*</span>
                </label>
                <select
                  value={newTask.project_id || ''}
                  onChange={(e) => setNewTask({ ...newTask, project_id: e.target.value || null })}
                  className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-indigo-400 dark:bg-slate-800/70 dark:text-white"
                >
                  <option value="" disabled>Select a project…</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {projects.length === 0 && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    No projects available to you yet — you can only assign tasks to projects you belong to.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3 p-3 bg-indigo-50/50 dark:bg-indigo-900/20 rounded-xl border border-indigo-100 dark:border-indigo-800/50">
                <input
                  type="checkbox"
                  id="mgr_is_absolute"
                  checked={newTask.is_absolute}
                  onChange={(e) => setNewTask({ ...newTask, is_absolute: e.target.checked })}
                  className="w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-blue-500"
                />
                <label htmlFor="mgr_is_absolute" className="text-sm font-medium text-indigo-800 dark:text-indigo-300">
                  Mark as Absolute Task (Lock for students)
                </label>
              </div>

              {createError && (
                <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600 flex items-center gap-2">
                  <span>⚠</span> {createError}
                </div>
              )}

              <button
                onClick={handleCreateTask}
                disabled={!newTask.title.trim() || !newTask.project_id}
                className="w-full py-3 bg-gradient-to-r from-indigo-500 to-violet-500 text-white rounded-xl font-medium disabled:opacity-50 hover:from-blue-600 hover:to-cyan-600 transition-all"
              >
                Create Task
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Task Modal */}
      {isEditModalOpen && editingTask && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
          <div className="bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl rounded-2xl shadow-2xl max-w-4xl w-full p-6 max-h-[90vh] overflow-y-auto border dark:border-slate-700">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
                ✏️ Edit Task
              </h2>
              <button onClick={() => { setIsEditModalOpen(false); setEditingTask(null); }} className="p-2 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Two-column layout */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Left: Edit Form */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                    Task Title
                  </label>
                  <input
                    type="text"
                    value={editingTask.title}
                    onChange={(e) => setEditingTask({ ...editingTask, title: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-indigo-400 dark:bg-slate-800/70 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Description</label>
                  <DescriptionEditor
                    value={editingTask.description || ''}
                    onChange={(description) => setEditingTask({ ...editingTask, description })}
                    placeholder="Describe the task, or use “Fill from file” to import from a .txt/.md/.csv/.docx/.pdf"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                      Priority
                    </label>
                    <select
                      value={editingTask.priority}
                      onChange={(e) => setEditingTask({ ...editingTask, priority: e.target.value as any })}
                      className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-indigo-400 dark:bg-slate-800/70 dark:text-white"
                    >
                      <option value="high">High Priority</option>
                      <option value="medium">Medium Priority</option>
                      <option value="low">Low Priority</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Due Date</label>
                    <input
                      type="date"
                      value={editingTask.due_date ? editingTask.due_date.split('T')[0] : ''}
                      min={getTodayLocalDateString()}
                      onChange={(e) => setEditingTask({ ...editingTask, due_date: e.target.value })}
                      className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-indigo-400 dark:bg-slate-800/70 dark:text-white"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Start Date</label>
                    <input
                      type="date"
                      value={editingTask.start_date ? editingTask.start_date.split('T')[0] : ''}
                      max={getTodayLocalDateString()}
                      onChange={(e) => setEditingTask({ ...editingTask, start_date: e.target.value })}
                      className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-indigo-400 dark:bg-slate-800/70 dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Weight (Complexity)</label>
                    <input
                      type="number"
                      value={editingTask.complexity_weight || 1}
                      min="1"
                      max="13"
                      onChange={(e) => setEditingTask({ ...editingTask, complexity_weight: parseInt(e.target.value) || 1 })}
                      className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-indigo-400 dark:bg-slate-800/70 dark:text-white"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Assignees (Primary & Others)</label>
                  <MultiAssigneeSelect
                    taskId={editingTask.id}
                    currentAssignees={editingTask.assignees || []}
                    members={members}
                    onAssigneesChange={(newAssignees) => setEditingTask({ ...editingTask, assignees: newAssignees })}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Parent Task (Optional)</label>
                  <select
                    value={editingTask.parent_task_id || ''}
                    onChange={(e) => setEditingTask({ ...editingTask, parent_task_id: e.target.value || null })}
                    className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-indigo-400 dark:bg-slate-800/70 dark:text-white"
                  >
                    <option value="">No Parent (Root Task)</option>
                    {tasks.filter(t => t.status !== 'archived' && t.id !== editingTask.id && (t as any).source_type === 'sheet').map(t => (
                      <option key={t.id} value={t.id}>{t.wbs_code ? `${t.wbs_code} — ` : ''}{t.title}</option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-3 p-3 bg-indigo-50/50 dark:bg-indigo-900/20 rounded-xl border border-indigo-100 dark:border-indigo-800/50">
                  <input
                    type="checkbox"
                    id="mgr_edit_is_absolute"
                    checked={editingTask.is_absolute || false}
                    onChange={(e) => setEditingTask({ ...editingTask, is_absolute: e.target.checked })}
                    className="w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-blue-500"
                  />
                  <label htmlFor="mgr_edit_is_absolute" className="text-sm font-medium text-indigo-800 dark:text-indigo-300">
                    Mark as Absolute Task (Lock for students)
                  </label>
                </div>
                <div className="flex gap-3 pt-4">
                  <button
                    onClick={() => { setIsEditModalOpen(false); setEditingTask(null); }}
                    className="flex-1 py-3 border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-gray-200 rounded-xl font-medium hover:bg-gray-50 dark:hover:bg-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleUpdateTask}
                    disabled={!editingTask.title.trim()}
                    className="flex-1 py-3 bg-gradient-to-r from-indigo-500 to-violet-500 text-white rounded-xl font-medium disabled:opacity-50 hover:from-blue-600 hover:to-cyan-600"
                  >
                    Save Changes
                  </button>
                </div>
              </div>

              {/* Right: Task Timeline */}
              <div>
                <TaskTimeline
                  taskId={editingTask.id}
                  currentUserId={user?.id}
                />
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Google Sheet Sync Modal */}
      <GoogleSheetImportModal
        isOpen={isGoogleSyncModalOpen}
        onClose={() => setIsGoogleSyncModalOpen(false)}
        organizationId={organization.id}
        onImportComplete={() => fetchTasks()}
        teamId={selectedTeam}
        projectId={selectedProjectId}
      />

      {/* Dependency Dialog */}
      {dependencyTask && dependencyTask.project_id && (
        <DependencyDialog
          taskId={dependencyTask.id}
          taskTitle={dependencyTask.title}
          projectId={dependencyTask.project_id}
          onClose={() => setDependencyTask(null)}
        />
      )}

      {/* Recycle Tasks Modal (Rev 4) */}
      <RecycleTasksModal
        isOpen={isRecycleOpen}
        onClose={() => setIsRecycleOpen(false)}
        organizationId={organization.id}
        sourceTaskIds={selectedArchiveIds}
        onRecycled={() => {
          setSelectedArchiveIds([])
          fetchArchivedTasks(0, false)
          fetchTasks()
          fetchProjects()
        }}
      />
    </div>
  )
}
