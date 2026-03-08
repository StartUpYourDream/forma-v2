import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Chat from './components/Chat'
import MemberPanel from './components/MemberPanel'
import FileBrowser from './components/FileBrowser'
import Login from './pages/Login'
import Register from './pages/Register'
import { useStore } from './store'

// 主应用布局
function MainLayout() {
  const {
    currentProject,
    showFileBrowser,
    setShowFileBrowser
  } = useStore()

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

// 路由保护组件
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token, isAuthenticated } = useStore()
  const [checking, setChecking] = useState(true)
  const [valid, setValid] = useState(false)

  useEffect(() => {
    // 检查本地存储的 token
    const storedToken = localStorage.getItem('forma_token')
    if (storedToken && !token) {
      // 恢复 token 到 store
      useStore.setState({ token: storedToken, isAuthenticated: true })
      setValid(true)
    } else if (isAuthenticated && token) {
      setValid(true)
    }
    setChecking(false)
  }, [token, isAuthenticated])

  if (checking) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="text-gray-500">加载中...⏳</div>
      </div>
    )
  }

  if (!valid) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

// 公开路由（已登录用户自动跳转）
function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useStore()
  const storedToken = localStorage.getItem('forma_token')

  if (isAuthenticated || storedToken) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}

// 应用初始化组件
function AppInitializer({ children }: { children: React.ReactNode }) {
  const { initAuth, isAuthenticated } = useStore()
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    initAuth().finally(() => setInitialized(true))
  }, [])

  if (!initialized) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="text-gray-500">加载中...⏳</div>
      </div>
    )
  }

  return <>{children}</>
}

function App() {
  return (
    <BrowserRouter>
      <AppInitializer>
        <Routes>
          <Route
            path="/login"
            element={
              <PublicRoute>
                <Login />
              </PublicRoute>
            }
          />
          <Route
            path="/register"
            element={
              <PublicRoute>
                <Register />
              </PublicRoute>
            }
          />
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <MainLayout />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AppInitializer>
    </BrowserRouter>
  )
}

export default App