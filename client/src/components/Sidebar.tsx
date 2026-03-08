import { useEffect, useState } from 'react'
import {
  Search, Plus, ChevronDown, ChevronRight,
  Star, Pin, MessageSquare,
  Settings
} from 'lucide-react'
import { useStore } from '../store'

export default function Sidebar() {
  const {
    currentTeam,
    currentProject,
    teams,
    projects,
    setCurrentTeam,
    setCurrentProject,
    loadTeams,
    loadProjects,
    createProject
  } = useStore()

  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set(['team-1']))
  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')

  useEffect(() => {
    loadTeams()
  }, [])

  useEffect(() => {
    if (currentTeam) {
      loadProjects(currentTeam)
    }
  }, [currentTeam])

  const toggleTeam = (teamId: string) => {
    const newExpanded = new Set(expandedTeams)
    if (newExpanded.has(teamId)) {
      newExpanded.delete(teamId)
    } else {
      newExpanded.add(teamId)
    }
    setExpandedTeams(newExpanded)
  }

  // [问题4] 修复 async/await 不匹配：await setCurrentTeam 完成后再设置项目
  const handleSelectProject = async (teamId: string, projectId: string) => {
    if (teamId !== currentTeam) {
      await setCurrentTeam(teamId)
    }
    setCurrentProject(projectId)
  }

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newProjectName.trim() || !currentTeam) return
    await createProject(newProjectName)
    setNewProjectName('')
    setShowNewProject(false)
  }

  return (
    <>
      {/* 飞书风格左侧栏 */}
      <div className="w-72 bg-gray-50 border-r border-gray-200 flex flex-col">
        {/* 顶部搜索 */}
        <div className="h-14 px-4 flex items-center border-b border-gray-200">
          <div className="flex-1 flex items-center gap-2 bg-white rounded-lg px-3 py-1.5 border border-gray-200">
            <Search size={16} className="text-gray-400" />
            <input
              type="text"
              placeholder="搜索项目、消息..."
              className="flex-1 bg-transparent text-sm outline-none text-gray-700 placeholder-gray-400"
            />
          </div>
        </div>

        {/* 快捷入口 */}
        <div className="px-3 py-2">
          <button className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 text-gray-700">
            <Star size={18} className="text-yellow-500" />
            <span className="text-sm">收藏</span>
          </button>
          <button className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 text-gray-700">
            <Pin size={18} className="text-blue-500" />
            <span className="text-sm">置顶</span>
          </button>
        </div>

        <div className="border-t border-gray-200 my-1"></div>

        {/* 项目列表（飞书风格树形） */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-semibold text-gray-500">项目</span>
            <button
              onClick={() => setShowNewProject(true)}
              className="p-1 hover:bg-gray-200 rounded text-gray-500"
            >
              <Plus size={16} />
            </button>
          </div>

          {/* 团队-项目树形结构 */}
          {teams.map(team => {
            const isExpanded = expandedTeams.has(team.id)
            const teamProjects = projects.filter(p => p.team_id === team.id)

            return (
              <div key={team.id} className="mb-1">
                {/* 团队标题 */}
                <button
                  onClick={() => toggleTeam(team.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-100 text-gray-700"
                >
                  {isExpanded ? (
                    <ChevronDown size={16} className="text-gray-400" />
                  ) : (
                    <ChevronRight size={16} className="text-gray-400" />
                  )}
                  <div className="w-6 h-6 bg-indigo-100 rounded flex items-center justify-center">
                    <span className="text-xs font-bold text-indigo-600">{team.name.charAt(0)}</span>
                  </div>
                  <span className="font-medium text-sm">{team.name}</span>
                </button>

                {/* 项目列表 */}
                {isExpanded && (
                  <div className="ml-6 mt-1 space-y-1">
                    {teamProjects.map(project => (
                      <button
                        key={project.id}
                        onClick={() => handleSelectProject(team.id, project.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                          currentProject === project.id
                            ? 'bg-indigo-50 text-indigo-700'
                            : 'text-gray-600 hover:bg-gray-100'
                        }`}
                      >
                        <MessageSquare size={16} className={currentProject === project.id ? 'text-indigo-600' : 'text-gray-400'} />
                        <span className="truncate flex-1 text-left">{project.name}</span>
                        {currentProject === project.id && (
                          <div className="w-1.5 h-1.5 bg-indigo-600 rounded-full"></div>
                        )}
                      </button>
                    ))}

                    {/* 添加项目按钮 */}
                    <button
                      onClick={async () => {
                        await setCurrentTeam(team.id)
                        setShowNewProject(true)
                      }}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:bg-gray-100"
                    >
                      <Plus size={16} />
                      <span>新建项目</span>
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 底部用户栏 */}
        <div className="p-3 border-t border-gray-200">
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 cursor-pointer"
          >
            <img
              src="https://api.dicebear.com/7.x/avataaars/svg?seed=votan"
              alt="avatar"
              className="w-9 h-9 rounded-full bg-gray-200"
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-800 truncate">Votan</div>
              <div className="text-xs text-gray-500">在线</div>
            </div>
            <Settings size={18} className="text-gray-400" />
          </div>
        </div>
      </div>

      {/* 新建项目弹窗 */}
      {showNewProject && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-xl w-96 shadow-xl">
            <h3 className="font-semibold text-lg mb-4 text-gray-800">新建项目</h3>
            <form onSubmit={handleCreateProject}>
              <div className="mb-4">
                <label className="block text-sm text-gray-600 mb-1">项目名称</label>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="例如：Tlist"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-800 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  autoFocus
                />
              </div>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowNewProject(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                >
                  创建
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
