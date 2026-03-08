import { useState, useEffect } from 'react';
import { Folder, File, ChevronRight, ChevronDown, X } from 'lucide-react';

interface FileNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: Record<string, FileNode>;
  content?: string;
}

export default function FileBrowser({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadFiles();
  }, [projectId]);

  const loadFiles = async () => {
    const res = await fetch(`/api/projects/${projectId}/files`);
    const fileList = await res.json();
    const tree = buildFileTree(fileList);
    setFiles(tree);
  };

  // [问题6] 修复：文件夹使用独立 ID（folder-${path}），避免与文件 ID 冲突
  // [问题23] 统一 children 类型为 Record<string, FileNode>
  const buildFileTree = (fileList: any[]): FileNode[] => {
    const root: Record<string, FileNode> = {};

    if (!Array.isArray(fileList)) return [];

    for (const file of fileList) {
      const parts = file.path.split('/');
      let current = root;
      let currentPath = '';

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath = currentPath ? `${currentPath}/${part}` : part;

        if (!current[part]) {
          const isFile = i === parts.length - 1;
          current[part] = {
            id: isFile ? file.id : `folder-${currentPath}`,
            name: part,
            path: currentPath,
            type: isFile ? 'file' : 'folder',
            children: isFile ? undefined : {}
          };
        }

        if (i < parts.length - 1) {
          current = current[part].children!;
        }
      }
    }

    return Object.values(root);
  };

  const toggleFolder = (path: string) => {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(path)) newExpanded.delete(path);
    else newExpanded.add(path);
    setExpandedFolders(newExpanded);
  };

  const openFile = async (file: FileNode) => {
    const res = await fetch(`/api/projects/${projectId}/files/${file.path}`);
    const fileData = await res.json();
    setSelectedFile({ ...file, content: fileData.content });
  };

  const renderNode = (node: FileNode, depth = 0) => {
    const isExpanded = expandedFolders.has(node.path);
    const paddingLeft = depth * 16 + 12;

    return (
      <div key={node.path}>
        <button
          onClick={() => node.type === 'folder' ? toggleFolder(node.path) : openFile(node)}
          className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-100 text-left transition-colors ${
            selectedFile?.path === node.path ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700'
          }`}
          style={{ paddingLeft }}
        >
          {node.type === 'folder' ? (
            <>
              {isExpanded ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
              <Folder size={16} className="text-yellow-500" />
            </>
          ) : (
            <>
              <span className="w-[14px]" />
              <File size={16} className="text-blue-500" />
            </>
          )}
          <span className="truncate">{node.name}</span>
        </button>

        {node.type === 'folder' && isExpanded && node.children && (
          <div>{Object.values(node.children).map((child) => renderNode(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white w-[900px] h-[600px] rounded-xl shadow-2xl flex overflow-hidden">
        {/* File Tree */}
        <div className="w-64 border-r border-gray-200 flex flex-col">
          <div className="h-14 px-4 flex items-center justify-between border-b border-gray-200">
            <span className="font-semibold text-gray-800">项目文件</span>
            <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500">
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {files.length === 0 ? (
              <div className="text-center text-gray-400 text-sm py-8">暂无文件</div>
            ) : (
              files.map(node => renderNode(node))
            )}
          </div>
        </div>

        {/* File Content */}
        <div className="flex-1 flex flex-col bg-gray-50">
          {selectedFile ? (
            <>
              <div className="h-12 px-4 flex items-center border-b border-gray-200 bg-white">
                <span className="text-sm text-gray-600 font-mono">{selectedFile.path}</span>
              </div>
              <div className="flex-1 overflow-auto p-4">
                <pre className="text-sm text-gray-800 font-mono whitespace-pre-wrap bg-white p-4 rounded-lg border border-gray-200">{selectedFile.content || '无法预览此文件'}</pre>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-400">选择文件查看内容</div>
          )}
        </div>
      </div>
    </div>
  );
}
