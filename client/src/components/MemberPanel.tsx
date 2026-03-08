import { useEffect } from 'react'
import { Users, Folder, FileText } from 'lucide-react'
import { useStore } from '../store'
import { getStatusColor } from '../utils'

export default function MemberPanel() {
  const { currentTeam, members, loadMembers } = useStore()

  useEffect(() => {
    if (currentTeam) {
      loadMembers(currentTeam)
    }
  }, [currentTeam])

  const humans = members.filter(m => m.type === 'user')
  const agents = members.filter(m => m.type === 'agent')

  return (
    <div className="w-64 bg-gray-50 border-l border-gray-200 flex flex-col">
      {/* 头部 */}
      <div className="h-14 px-4 flex items-center justify-between border-b border-gray-200">
        <div className="flex items-center gap-2">
          <Users size={18} className="text-gray-600" />
          <span className="font-semibold text-gray-800">团队成员</span>
        </div>
        <span className="text-xs text-gray-500">{members.length} 人</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {/* 真人成员 */}
        {humans.length > 0 && (
          <div className="mb-4">
            <div className="text-xs font-semibold text-gray-500 mb-2 px-2">在线成员</div>
            {humans.map(member => (
              <div key={member.id} className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-100"
              >
                <div className="relative">
                  <img src={member.avatar} alt={member.name} className="w-8 h-8 rounded-full bg-gray-200" />
                  <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-gray-50 ${getStatusColor(member.status)}`} />
                </div>
                <span className="text-sm text-gray-700">{member.name}</span>
              </div>
            ))}
          </div>
        )}

        {/* AI Agent */}
        {agents.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-gray-500 mb-2 px-2 flex items-center gap-1">
              <span>AI Agent</span>
              <span className="text-gray-400">(团队共享)</span>
            </div>
            {agents.map(agent => (
              <div key={agent.id} className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-100"
              >
                <div className="relative">
                  <img src={agent.avatar} alt={agent.name} className="w-8 h-8 rounded-full bg-indigo-100" />
                  <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-gray-50 ${getStatusColor(agent.status)}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-700 truncate">{agent.name}</div>
                  {agent.status === 'working' && (
                    <div className="text-xs text-yellow-600">工作中...</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-gray-200 my-3"></div>

        {/* 快捷操作 */}
        <div className="space-y-1">
          <button className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-100 text-gray-600">
            <Folder size={16} />
            <span className="text-sm">项目文件</span>
          </button>
          <button className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-100 text-gray-600">
            <FileText size={16} />
            <span className="text-sm">需求文档</span>
          </button>
        </div>
      </div>
    </div>
  )
}
