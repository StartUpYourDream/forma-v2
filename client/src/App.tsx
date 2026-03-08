import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import Chat from './components/Chat'
import MemberPanel from './components/MemberPanel'
import FileBrowser from './components/FileBrowser'
import { useStore } from './store'

function App() {
  const {
    setCurrentUser,
    currentProject,
    showFileBrowser,
    setShowFileBrowser,
    connectWebSocket
  } = useStore()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/me')
      .then(res => res.json())
      .then(user => {
        setCurrentUser(user)
        connectWebSocket(user.id)
        setLoading(false)
      })
      .catch(err => {
        console.error('Failed to load user:', err)
        setLoading(false)
      })
  }, [])

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="text-gray-500">加载中...⏳</div>
      </div>
    )
  }

  return (
    <div className="h-screen flex bg-white">
      <Sidebar />

      <div className="flex-1 flex">
        <Chat />
        <MemberPanel />
      </div>

      {showFileBrowser && currentProject && (
        <FileBrowser
          projectId={currentProject}
          onClose={() => setShowFileBrowser(false)}
        />
      )}
    </div>
  )
}

export default App
