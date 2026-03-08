import { useEffect } from 'react'
import { useStore } from '../store'
import { getStatusColor } from '../utils'

export default function MemberList() {
  const { currentTeam, members, loadMembers } = useStore()

  useEffect(() => {
    if (currentTeam) {
      loadMembers(currentTeam)
    }
  }, [currentTeam])

  const humans = members.filter(m => m.type === 'user')
  const agents = members.filter(m => m.type === 'agent')

  return (
    <div className="w-60 bg-gray-800 border-l border-gray-700 flex flex-col">
      <div className="h-16 px-4 flex items-center border-b border-gray-700">
        <h2 className="font-semibold text-gray-300">团队成员</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {/* Humans */}
        {humans.length > 0 && (
          <div className="mb-4">
            <div className="text-xs font-semibold text-gray-500 uppercase mb-2 px-2">
              真人
            </div>
            {humans.map(member => (
              <div key={member.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-700">
                <div className="relative">
                  <img src={member.avatar} alt={member.name} className="w-8 h-8 rounded-full bg-gray-600" />
                  <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-gray-800 ${getStatusColor(member.status)}`} />
                </div>
                <span className="text-sm text-gray-300">{member.name}</span>
              </div>
            ))}
          </div>
        )}

        {/* Agents */}
        {agents.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase mb-2 px-2">
              AI Agent（团队共享）
            </div>
            {agents.map(agent => (
              <div key={agent.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-700">
                <div className="relative">
                  <img src={agent.avatar} alt={agent.name} className="w-8 h-8 rounded-full bg-indigo-900" />
                  <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-gray-800 ${getStatusColor(agent.status)}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-indigo-300 truncate">{agent.name}</div>
                  {agent.status === 'working' && (
                    <div className="text-xs text-yellow-400">工作中...</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
