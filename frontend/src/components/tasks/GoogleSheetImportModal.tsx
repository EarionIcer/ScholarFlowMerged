"use client"

import { useState, useEffect, useCallback } from 'react'
import {
    X,
    FileText, // Changed from FileType to FileText to match original icon
    AlertCircle,
    CheckCircle2,
    ChevronRight,
    Search,
    Loader2,
    RefreshCw,
    FilePlus2, // Changed from Download to FilePlus2 to match original icon
    ExternalLink,
    Clock
} from 'lucide-react'
import apiClient from '@/lib/api/client'

interface Spreadsheet {
    id: string
    name: string
    modifiedTime: string
}

interface GoogleSheetImportModalProps {
    isOpen: boolean
    onClose: () => void
    organizationId: string
    onImportComplete: () => void
    teamId?: string | null
    projectId?: string | null
}

interface PreviewTask {
    title: string
    status: string
    assigneeEmail?: string
    wbs_code?: string
    isAbsolute: boolean
}

interface PreviewData {
    totalTasks: number
    tasks: PreviewTask[]
    hasMore: boolean
}

export default function GoogleSheetImportModal({
    isOpen, onClose, organizationId, onImportComplete, teamId, projectId
}: GoogleSheetImportModalProps) {
    const [step, setStep] = useState<'select' | 'preview' | 'syncing' | 'done'>('select')
    const [syncMode, setSyncMode] = useState<'browse' | 'url'>('url')
    const [sheets, setSheets] = useState<Spreadsheet[]>([]) // Renamed spreadsheets to sheets
    const [loading, setLoading] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [pastedUrl, setPastedUrl] = useState('')
    const [selectedSheet, setSelectedSheet] = useState<Spreadsheet | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [creatingTemplate, setCreatingTemplate] = useState(false)
    const [newSheetUrl, setNewSheetUrl] = useState<string | null>(null)
    const [preview, setPreview] = useState<PreviewData | null>(null)
    const [workspaceId, setWorkspaceId] = useState<string | null>(null)

    useEffect(() => {
        if (isOpen && step === 'select') {
            fetchSheets()
        }
    }, [isOpen, step])

    const fetchSheets = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const response = await apiClient.get('/sheets/list')
            if (response.data) {
                setSheets(response.data.files || [])
            }
        } catch (err: any) {
            console.error('Error fetching sheets:', err)
            setError(err.response?.data?.error || 'Failed to load Google Sheets')
        } finally {
            setLoading(false)
        }
    }, [])

    const extractSheetId = (url: string) => {
        const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/)
        return match ? match[1] : null
    }

    const ensureWorkspace = async () => {
        try {
            const response = await apiClient.get(`/workspaces?organizationId=${organizationId}`)
            if (response.data) {
                const workspaces = response.data.workspaces || []
                if (workspaces.length > 0) {
                    return workspaces[0]
                } else {
                    const createWsRes = await apiClient.post('/workspaces', {
                        organizationId,
                        folderId: 'root',
                        folderName: 'Default Workspace'
                    })
                    return { id: createWsRes.data.workspaceId }
                }
            }
            return null
        } catch (err) {
            console.error('Error ensuring workspace:', err)
            return null
        }
    }

    const handlePreview = async (sheetFromUrl?: Spreadsheet) => {
        const sheetToPreview = sheetFromUrl || selectedSheet
        if (!sheetToPreview) return
        
        setLoading(true)
        setError(null)
        try {
            const workspace = await ensureWorkspace()
            if (!workspace) throw new Error('Could not resolve workspace')
            setWorkspaceId(workspace.id)

            const response = await apiClient.post(`/workspaces/${workspace.id}/preview-sheet`, { sheetId: sheetToPreview.id })
            if (response.data) {
                setPreview(response.data.preview)
                if (sheetFromUrl) setSelectedSheet(sheetFromUrl)
                setStep('preview')
            }
        } catch (err: any) {
            console.error('Error previewing sheet:', err)
            setError(err.response?.data?.error || 'Failed to preview sheet')
        } finally {
            setLoading(false)
        }
    }

    const handleUrlSync = () => {
        const id = extractSheetId(pastedUrl)
        if (!id) {
            setError('Invalid Google Sheet URL')
            return
        }
        handlePreview({ id, name: 'Work Breakdown Structure', modifiedTime: new Date().toISOString() })
    }

    const handleConfirmSync = async () => {
        if (!selectedSheet || !workspaceId) return
        setStep('syncing')
        setError(null)
        try {
            await apiClient.post(`/workspaces/${workspaceId}/connect-sheet`, {
                sheetId: selectedSheet.id,
                sheetName: selectedSheet.name,
                teamId: teamId || undefined,
                projectId: projectId || undefined
            })
            setStep('done')
        } catch (err: any) {
            console.error('Error syncing:', err)
            setError(err.response?.data?.error || 'Failed to sync')
            setStep('preview')
        }
    }

    const handleCreateTemplate = async () => {
        setCreatingTemplate(true)
        setError(null)
        try {
            const response = await apiClient.post(`/organizations/${organizationId}/tasks/create-wbs-template`)
            if (response.data) {
                setNewSheetUrl(response.data.url)
                fetchSheets()
            }
        } catch (err: any) {
            console.error('Error creating template:', err)
            setError('Failed to create template')
        } finally {
            setCreatingTemplate(false)
        }
    }

    const handleClose = () => {
        setStep('select')
        setSelectedSheet(null)
        setError(null)
        onClose()
        if (step === 'done') onImportComplete()
    }

    if (!isOpen) return null

    const filteredSheets = sheets.filter(s => 
        s.name.toLowerCase().includes(searchQuery.toLowerCase())
    )

    return (
        <div className="fixed inset-0 bg-black/40 dark:bg-slate-950/60 backdrop-blur-md flex items-center justify-center z-[100] p-4 animate-in fade-in duration-300">
            <div className="bg-white/95 dark:bg-slate-900/90 backdrop-blur-xl rounded-[2rem] shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col border border-gray-100 dark:border-slate-700/50 shadow-black/10 transition-all duration-500 transform animate-in zoom-in-95">
                
                {/* Header */}
                <div className="flex items-center justify-between p-8 border-b border-gray-100 dark:border-slate-800/50 bg-gradient-to-br from-emerald-500/5 to-teal-500/5 dark:from-emerald-500/10 dark:to-teal-500/10">
                    <div className="flex items-center gap-4">
                        <div className="p-3 bg-gradient-to-br from-emerald-500 to-teal-500 rounded-2xl shadow-lg shadow-emerald-500/20">
                            <FileText className="w-6 h-6 text-white" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-black text-gray-900 dark:text-white uppercase tracking-tight">Sync WBS</h2>
                            <p className="text-sm font-medium text-gray-500 dark:text-slate-400">Import your Work Breakdown Structure to the Advisor Board</p>
                        </div>
                    </div>
                    <button onClick={handleClose} className="p-2.5 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-xl transition-all hover:rotate-90 duration-300 group">
                        <X className="w-6 h-6 text-gray-400 group-hover:text-gray-900 dark:group-hover:text-white" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
                    
                    {step === 'select' && (
                        <div className="space-y-8">
                            {/* Sky Guide Banner */}
                            <div className="flex gap-4 p-5 bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-500/10 dark:to-teal-500/10 border border-emerald-200 dark:border-emerald-500/20 rounded-2xl">
                                <div className="text-2xl select-none">🎓</div>
                                <div>
                                    <p className="text-xs font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-400 mb-1">How this works</p>
                                    <ol className="text-xs font-medium text-emerald-800 dark:text-emerald-300/80 space-y-1 leading-relaxed list-decimal list-inside">
                                        <li>Your student team builds their WBS in <span className="font-bold">Google Sheets</span></li>
                                        <li>They set sharing to <span className="font-bold underline">"Anyone with the link"</span> (Viewer)</li>
                                        <li>They copy and send you the link</li>
                                        <li>Paste it below — tasks auto-populate the <span className="font-bold">Advisor Board</span></li>
                                        <li>Tasks are <span className="font-bold text-rose-600 dark:text-rose-400">locked</span> — team drags progress only, cannot delete</li>
                                    </ol>
                                </div>
                            </div>
                            {/* Sync Mode Toggle */}
                            <div className="flex p-1 bg-gray-100 dark:bg-slate-800 rounded-2xl">
                                <button
                                    onClick={() => setSyncMode('url')}
                                    className={`flex-1 py-3 px-4 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${syncMode === 'url' ? 'bg-white dark:bg-slate-700 text-emerald-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                >
                                    Link via URL
                                </button>
                                <button
                                    onClick={() => setSyncMode('browse')}
                                    className={`flex-1 py-3 px-4 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${syncMode === 'browse' ? 'bg-white dark:bg-slate-700 text-emerald-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                >
                                    Browse My Drive
                                </button>
                            </div>

                            {syncMode === 'url' ? (
                                <div className="space-y-6">
                                    <div className="relative group">
                                        <div className="absolute left-4 top-1/2 -translate-y-1/2 p-2 bg-emerald-500/10 rounded-lg">
                                            <ExternalLink className="w-5 h-5 text-emerald-500" />
                                        </div>
                                        <input 
                                            type="text"
                                            placeholder="Paste Google Sheet URL here..."
                                            value={pastedUrl}
                                            onChange={(e) => setPastedUrl(e.target.value)}
                                            className="w-full pl-16 pr-4 py-5 bg-gray-50 dark:bg-slate-800 border-2 border-transparent dark:border-slate-800/50 rounded-[1.5rem] text-slate-800 dark:text-slate-100 focus:outline-none focus:bg-white dark:focus:bg-slate-800 focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all placeholder-gray-400 dark:placeholder-slate-500 font-bold text-lg"
                                        />
                                    </div>
                                    <div className="p-6 bg-blue-50 dark:bg-blue-500/5 border border-blue-100 dark:border-blue-500/20 rounded-[1.5rem]">
                                        <div className="flex gap-3">
                                            <CheckCircle2 className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
                                            <div>
                                                <p className="text-sm font-black text-blue-900 dark:text-blue-400 uppercase tracking-tight">Requirement</p>
                                                <p className="text-xs font-medium text-blue-700 dark:text-blue-300/70 mt-1 leading-relaxed">
                                                    Ensure "Anyone with the link" is set to <span className="font-bold underline">Viewer</span> or share it with the system service account before linking.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="relative group">
                                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-slate-500 group-focus-within:text-emerald-500 transition-colors" />
                                    <input 
                                        type="text"
                                        placeholder="Search your Google Sheets..."
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        className="w-full pl-12 pr-4 py-4 bg-gray-50 dark:bg-slate-800 border-2 border-transparent dark:border-slate-800/50 rounded-2xl text-slate-800 dark:text-slate-100 focus:outline-none focus:bg-white dark:focus:bg-slate-800 focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all placeholder-gray-400 dark:placeholder-slate-500 font-medium"
                                    />
                                </div>
                            )}

                            {/* Error Alert */}
                            {error && (
                                <div className="flex items-start gap-4 p-5 bg-rose-50 dark:bg-rose-500/10 border border-rose-100 dark:border-rose-500/20 rounded-2xl animate-in shake duration-500">
                                    <div className="p-1.5 bg-rose-500 rounded-lg shrink-0">
                                        <AlertCircle className="w-4 h-4 text-white" />
                                    </div>
                                    <p className="text-sm font-bold text-rose-700 dark:text-rose-400 leading-relaxed">{error}</p>
                                </div>
                            )}

                            {/* Sheet List */}
                            <div className="space-y-3 pr-2">
                                {loading ? (
                                    <div className="flex flex-col items-center justify-center py-16 gap-4">
                                        <div className="w-12 h-12 border-[3px] border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
                                        <p className="text-xs font-black uppercase tracking-widest text-gray-400 dark:text-slate-500">Loading sheets...</p>
                                    </div>
                                ) : filteredSheets.length === 0 ? (
                                    <div className="text-center py-16 bg-gray-50 dark:bg-slate-800/30 rounded-[2rem] border-2 border-dashed border-gray-200 dark:border-slate-800">
                                        <div className="w-16 h-16 bg-gray-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 border border-gray-200 dark:border-slate-700">
                                            <FileText className="w-8 h-8 text-gray-300 dark:text-slate-600" />
                                        </div>
                                        <p className="text-gray-900 dark:text-slate-200 font-black uppercase tracking-tight">No spreadsheets found</p>
                                        <p className="text-sm text-gray-500 dark:text-slate-500 mt-2">Create a new WBS template below to get started</p>
                                    </div>
                                ) : (
                                    filteredSheets.map((sheet) => (
                                        <button
                                            key={sheet.id}
                                            onClick={() => setSelectedSheet(sheet)}
                                            className={`w-full flex items-center justify-between p-5 rounded-2xl border-2 transition-all duration-300 ${
                                                selectedSheet?.id === sheet.id 
                                                ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-500 shadow-lg shadow-emerald-500/10 -translate-y-0.5' 
                                                : 'bg-gray-50/50 dark:bg-slate-800/40 border-gray-100 dark:border-slate-700/50 hover:bg-white dark:hover:bg-slate-800 hover:shadow-md'
                                            }`}
                                        >
                                            <div className="flex items-center gap-4 text-left overflow-hidden">
                                                <div className={`p-3 rounded-xl transition-colors ${selectedSheet?.id === sheet.id ? 'bg-emerald-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500'}`}>
                                                    <FileText className="w-5 h-5" />
                                                </div>
                                                <div className="overflow-hidden">
                                                    <p className={`text-lg font-black tracking-tight truncate ${selectedSheet?.id === sheet.id ? 'text-emerald-900 dark:text-emerald-400' : 'text-gray-900 dark:text-slate-200'}`}>
                                                        {sheet.name}
                                                    </p>
                                                    <div className="flex items-center gap-2 mt-0.5">
                                                        <Clock className="w-3 h-3 text-gray-400" />
                                                        <p className="text-xs font-bold text-gray-400 dark:text-slate-500 uppercase">
                                                            Updated {new Date(sheet.modifiedTime).toLocaleDateString()}
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className={`p-1 rounded-full transition-all ${selectedSheet?.id === sheet.id ? 'bg-emerald-500 scale-100' : 'bg-gray-200 dark:bg-slate-700 scale-0'}`}>
                                                <CheckCircle2 className="w-5 h-5 text-white" />
                                            </div>
                                        </button>
                                    ))
                                )}
                            </div>

                             {/* Quick Tip & Template Creation */}
                            <div className="bg-slate-900 dark:bg-black rounded-[2rem] p-8 text-white relative overflow-hidden shadow-xl">
                                <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl -mr-10 -mt-10" />
                                
                                <div className="relative z-10">
                                    <div className="flex items-center gap-2 mb-4">
                                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                                        <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-500">Advisor Expert Tip</h4>
                                    </div>
                                    
                                    <p className="text-sm font-medium text-slate-300 leading-relaxed mb-6">
                                        Your sheet must have a <span className="text-white font-black underline decoration-emerald-500 decoration-2">Tasks (WBS)</span> column. 
                                        We'll automatically map headers like <span className="text-emerald-400 font-bold">Assignee</span>, <span className="text-emerald-400 font-bold">Priority</span>, and <span className="text-emerald-400 font-bold">Progress %</span>.
                                    </p>

                                    <div className="flex items-center gap-4">
                                        <button
                                            onClick={handleCreateTemplate}
                                            disabled={creatingTemplate}
                                            className="flex-1 flex items-center justify-center gap-2 px-6 py-4 bg-emerald-500 hover:bg-emerald-600 active:scale-[0.98] text-white rounded-2xl text-sm font-black uppercase tracking-wider transition-all disabled:opacity-50 shadow-lg shadow-emerald-500/20"
                                        >
                                            {creatingTemplate ? <Loader2 className="w-5 h-5 animate-spin" /> : <FilePlus2 className="w-5 h-5" />}
                                            <span>Create WBS Template</span>
                                        </button>
                                        
                                        {newSheetUrl && (
                                            <a 
                                                href={newSheetUrl} 
                                                target="_blank" 
                                                rel="noopener noreferrer"
                                                className="p-4 bg-slate-800 hover:bg-slate-700 rounded-2xl transition-all group active:scale-95"
                                                title="Open in Google Sheets"
                                            >
                                                <ExternalLink className="w-5 h-5 text-emerald-400 group-hover:scale-110 transition-transform" />
                                            </a>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {step === 'preview' && preview && (
                        <div className="space-y-6 animate-in slide-in-from-right duration-500">
                            <div className="bg-blue-600 rounded-[2rem] p-8 text-white relative overflow-hidden shadow-xl">
                                <div className="absolute bottom-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-2xl -mb-10 -mr-10" />
                                <div className="relative z-10 flex items-start gap-5">
                                    <div className="p-4 bg-white/20 rounded-2xl backdrop-blur-md shrink-0">
                                        <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                        </svg>
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-black uppercase tracking-tight mb-2">Immutable Sync Enabled</h3>
                                        <p className="text-sm font-medium text-blue-100 leading-relaxed">
                                            These tasks are now "Advisor Absolute". Students can update progress percentages, but 
                                            cannot modify titles or delete items. <strong>Source of truth remains Google Sheets.</strong>
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center justify-between px-2">
                                <p className="text-xs font-black uppercase tracking-widest text-gray-500 dark:text-slate-500">
                                    Previewing <span className="text-emerald-500">{preview.totalTasks} tasks</span> from source
                                </p>
                            </div>

                            <div className="border border-gray-100 dark:border-slate-800 rounded-[2rem] overflow-hidden shadow-sm bg-gray-50/50 dark:bg-slate-900/50">
                                <table className="w-full text-sm border-collapse">
                                    <thead>
                                        <tr className="bg-white dark:bg-slate-800 border-b border-gray-100 dark:border-slate-700">
                                            <th className="px-6 py-4 text-left text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">Structural Task</th>
                                            <th className="px-6 py-4 text-left text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">Assignee</th>
                                            <th className="px-6 py-4 text-left text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 text-center">
                                                <AlertCircle className="w-4 h-4 mx-auto" />
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100 dark:divide-slate-800/50">
                                        {preview.tasks.map((task, idx) => (
                                            <tr key={idx} className="hover:bg-white dark:hover:bg-slate-800 transition-colors group">
                                                <td className="px-6 py-4">
                                                    <div className="font-bold text-gray-900 dark:text-white group-hover:text-emerald-500 transition-colors">{task.title}</div>
                                                    {task.wbs_code && (
                                                        <div className="text-[10px] font-black text-gray-400 dark:text-slate-500 mt-1 uppercase tracking-tighter">Code: {task.wbs_code}</div>
                                                    )}
                                                </td>
                                                <td className="px-6 py-4">
                                                    <span className="text-xs font-bold text-gray-500 dark:text-slate-400">
                                                        {task.assigneeEmail || 'UNASSIGNED'}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 text-center">
                                                    <div className="p-1.5 bg-rose-500/10 dark:bg-rose-500/20 rounded-lg inline-block">
                                                        <svg className="w-4 h-4 text-rose-600 dark:text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                                        </svg>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                {preview.hasMore && (
                                    <div className="bg-white/50 dark:bg-slate-800/50 py-4 text-[10px] font-black uppercase tracking-widest text-gray-400 text-center border-t border-gray-100 dark:border-slate-800 italic">
                                        + {preview.totalTasks - preview.tasks.length} structural items hidden in preview
                                    </div>
                                )}
                            </div>

                            <div className="flex gap-4 pt-4">
                                <button
                                    onClick={() => setStep('select')}
                                    className="px-8 py-4 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-100 rounded-2xl font-black uppercase tracking-wider text-xs transition-all active:scale-95"
                                >
                                    Back
                                </button>
                                <button
                                    onClick={handleConfirmSync}
                                    className="flex-1 px-8 py-4 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-2xl font-black uppercase tracking-wider text-xs shadow-xl shadow-emerald-500/20 hover:shadow-emerald-500/40 hover:-translate-y-1 transition-all active:scale-[0.98]"
                                >
                                    Confirm & Finalize Sync
                                </button>
                            </div>
                        </div>
                    )}

                    {step === 'syncing' && (
                        <div className="flex flex-col items-center justify-center py-24 gap-8">
                            <div className="relative">
                                <div className="w-24 h-24 border-[6px] border-emerald-100 dark:border-emerald-500/10 border-t-emerald-500 dark:border-t-emerald-500 rounded-full animate-spin shadow-2xl shadow-emerald-500/20" />
                                <RefreshCw className="w-10 h-10 text-emerald-500 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" />
                            </div>
                            <div className="text-center space-y-2">
                                <p className="text-2xl font-black text-gray-900 dark:text-white tracking-tight uppercase italic">Sync In Progress</p>
                                <p className="text-sm font-medium text-gray-500 dark:text-slate-400">Mapping workspace to <span className="text-emerald-500 font-bold">{selectedSheet?.name}</span></p>
                            </div>
                            <div className="flex gap-2">
                                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-bounce" />
                            </div>
                        </div>
                    )}

                    {step === 'done' && (
                        <div className="flex flex-col items-center justify-center py-20 gap-8 text-center animate-in zoom-in duration-500">
                            <div className="w-24 h-24 bg-gradient-to-br from-emerald-500 to-teal-500 rounded-[2rem] flex items-center justify-center shadow-2xl shadow-emerald-500/30 rotate-12 transition-transform hover:rotate-0 duration-500">
                                <CheckCircle2 className="w-12 h-12 text-white" />
                            </div>
                            <div className="space-y-3">
                                <p className="text-3xl font-black text-gray-900 dark:text-white tracking-tighter italic uppercase">Sync Complete</p>
                                <p className="text-sm font-medium text-gray-500 dark:text-slate-400 max-w-sm mx-auto leading-relaxed">
                                    Your board is synchronized. All structural changes in the sheet will reflect here automatically within 60 seconds.
                                </p>
                            </div>
                            <button
                                onClick={handleClose}
                                className="px-12 py-5 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-[2rem] font-black uppercase tracking-[0.2em] shadow-2xl hover:scale-105 active:scale-95 transition-all duration-300"
                            >
                                Done
                            </button>
                        </div>
                    )}
                </div>

                {/* Footer Progress Bar */}
                {step === 'select' && (
                    <div className="p-1 px-8 pb-8">
                        <div className="w-full bg-gray-100 dark:bg-slate-800 h-1 rounded-full overflow-hidden">
                            <div className="w-1/3 h-full bg-emerald-500 rounded-full shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                        </div>
                        <div className="flex items-center justify-between mt-6">
                            <button
                                onClick={handleClose}
                                className="text-xs font-black uppercase tracking-widest text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
                            >
                                (ESC) Cancel
                            </button>
                            <button
                                onClick={syncMode === 'url' ? handleUrlSync : () => handlePreview()}
                                disabled={(syncMode === 'url' ? !pastedUrl : !selectedSheet) || loading}
                                className="flex items-center gap-3 px-8 py-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl disabled:opacity-30 disabled:grayscale font-black uppercase tracking-wider text-xs shadow-xl shadow-emerald-500/20 transition-all hover:-translate-y-1 active:scale-95 group"
                            >
                                <span>{syncMode === 'url' ? 'Validate & Preview' : 'Preview Tasks'}</span>
                                <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
