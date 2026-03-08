import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import Chat from "./components/Chat";
import MemberPanel from "./components/MemberPanel";
import FileBrowser from "./components/FileBrowser";
import Login from "./pages/Login";
import Register from "./pages/Register";
import { useStore } from "./store";

function MainLayout() {
  const { currentProject, showFileBrowser, setShowFileBrowser } = useStore();

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
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useStore();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useStore();

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function AppInitializer({ children }: { children: React.ReactNode }) {
  const { initAuth } = useStore();
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    initAuth().finally(() => setInitialized(true));
  }, []);

  if (!initialized) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="text-gray-500">加载中...</div>
      </div>
    );
  }

  return <>{children}</>;
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
  );
}

export default App;
