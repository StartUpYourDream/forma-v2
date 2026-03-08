import { useEffect, useRef, useState, useCallback } from "react";
import { Send, FolderOpen, MoreHorizontal } from "lucide-react";
import { useStore } from "../store";

function filterMembers(members: any[], query: string) {
  return members
    .filter(
      (m) =>
        m.name.toLowerCase().includes(query.toLowerCase()) ||
        m.type === "agent",
    )
    .slice(0, 5);
}

interface MentionDropdownProps {
  members: any[];
  query: string;
  onSelect: (member: any) => void;
  position: { top: number; left: number };
}

function MentionDropdown({
  members,
  query,
  onSelect,
  position,
}: MentionDropdownProps) {
  const filtered = filterMembers(members, query);

  if (filtered.length === 0) return null;

  return (
    <div
      className="fixed z-50 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[180px]"
      style={{ top: position.top, left: position.left }}
    >
      {filtered.map((member, index) => (
        <button
          key={member.id}
          onClick={() => onSelect(member)}
          className={`w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-left ${index === 0 ? "bg-gray-50" : ""}`}
        >
          <img
            src={
              member.avatar ||
              `https://api.dicebear.com/7.x/${member.type === "agent" ? "bottts" : "avataaars"}/svg?seed=${member.id}`
            }
            alt={member.name}
            className="w-6 h-6 rounded-full"
          />
          <span className="text-sm text-gray-700">{member.name}</span>
          {member.type === "agent" && (
            <span className="text-xs text-indigo-500 ml-auto">AI</span>
          )}
        </button>
      ))}
    </div>
  );
}

export default function Chat() {
  const {
    currentTeam,
    currentProject,
    teams,
    projects,
    messages,
    members,
    streamingMessages,
    loadMessages,
    loadMembers,
    sendMessage,
    setShowFileBrowser,
  } = useStore();

  const [input, setInput] = useState("");
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionPosition, setMentionPosition] = useState({ top: 0, left: 0 });
  const [cursorPosition, setCursorPosition] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const currentProjectName =
    projects.find((p) => p.id === currentProject)?.name || "";
  // [问题13] 从 store 动态获取团队名
  const currentTeamName = teams.find((t) => t.id === currentTeam)?.name || "";

  useEffect(() => {
    if (currentProject) {
      loadMessages(currentProject);
      // [问题3] 使用 currentTeam 替代硬编码 'team-1'
      if (currentTeam) {
        loadMembers(currentTeam);
      }
    }
  }, [currentProject, currentTeam]);

  // [问题12] 智能滚动：只在用户已在底部时自动滚动
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const threshold = 100;
    isNearBottomRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      threshold;
  }, []);

  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamingMessages]);

  const handleSend = async () => {
    if (!input.trim() || !currentProject) return;

    // [问题5] 重命名变量避免冲突，用精确匹配替代 includes()
    const mentionMatches = input.match(/@(\S+)/g) || [];
    const mentions = mentionMatches
      .map((match) => {
        const name = match.slice(1);
        const member = members.find((mem) => mem.name === name);
        return member?.id;
      })
      .filter(Boolean) as string[];

    await sendMessage(input, mentions);
    setInput("");
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || 0;
    setInput(value);
    setCursorPosition(cursorPos);

    // 检测@提及
    const textBeforeCursor = value.slice(0, cursorPos);
    const mentionMatch = textBeforeCursor.match(/@([^\s@]*)$/);

    if (mentionMatch) {
      setMentionQuery(mentionMatch[1]);
      setShowMentions(true);

      // 计算下拉框位置
      if (textareaRef.current) {
        const rect = textareaRef.current.getBoundingClientRect();
        const lineHeight = 20; // 估算行高
        const lines = textBeforeCursor.split("\n").length;
        setMentionPosition({
          top: rect.top + lines * lineHeight + 10,
          left: rect.left + 10,
        });
      }
    } else {
      setShowMentions(false);
    }
  };

  const handleMentionSelect = (member: any) => {
    const textBeforeCursor = input.slice(0, cursorPosition);
    const textAfterCursor = input.slice(cursorPosition);

    // 替换@查询文本为完整提及
    const newTextBefore = textBeforeCursor.replace(
      /@[^\s@]*$/,
      `@${member.name} `,
    );
    const newValue = newTextBefore + textAfterCursor;

    setInput(newValue);
    setShowMentions(false);

    // 恢复焦点
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(
          newTextBefore.length,
          newTextBefore.length,
        );
      }
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showMentions) {
      if (e.key === "Escape") {
        setShowMentions(false);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        const filtered = filterMembers(members, mentionQuery);
        if (filtered.length > 0) {
          e.preventDefault();
          handleMentionSelect(filtered[0]);
        }
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const renderContent = (content: string) => {
    return content.split(/(@\S+)/g).map((part, i) => {
      if (part.startsWith("@")) {
        return (
          <span
            key={i}
            className="text-indigo-600 font-medium bg-indigo-50 px-1 rounded"
          >
            {part}
          </span>
        );
      }
      return part;
    });
  };

  if (!currentProject) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white">
        <div className="text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Send size={24} className="text-gray-400" />
          </div>
          <p className="text-gray-500">选择一个项目开始协作</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-white">
      {/* 顶部标题栏 */}
      <div className="h-14 px-6 flex items-center justify-between border-b border-gray-200">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-gray-800">
                {currentProjectName}
              </span>
              <span className="text-gray-400">/</span>
              <span className="text-sm text-gray-500">{currentTeamName}</span>
            </div>
            <div className="text-xs text-gray-400 mt-0.5">
              {messages.length} 条消息
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFileBrowser(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <FolderOpen size={16} />
            文件
          </button>
          <button className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg">
            <MoreHorizontal size={20} />
          </button>
        </div>
      </div>

      {/* 消息列表 */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 py-4 bg-white"
      >
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            还没有消息，开始你的第一个对话吧
          </div>
        ) : (
          messages.map((msg, index) => {
            const isAgent = msg.author_type === "agent";
            const isSystem = msg.author_type === "system";
            const showAvatar =
              index === 0 || messages[index - 1].author_id !== msg.author_id;

            if (isSystem) {
              return (
                <div key={msg.id} className="my-4 flex justify-center">
                  <div className="bg-gray-50 text-gray-500 text-sm px-4 py-2 rounded-lg whitespace-pre-line">
                    {msg.content}
                  </div>
                </div>
              );
            }

            return (
              <div key={msg.id} className="mb-4">
                {showAvatar ? (
                  <div className="flex gap-3">
                    <img
                      src={
                        msg.author_avatar ||
                        `https://api.dicebear.com/7.x/${isAgent ? "bottts" : "avataaars"}/svg?seed=${msg.author_id}`
                      }
                      alt={msg.author_name}
                      className="w-10 h-10 rounded-full bg-gray-100"
                    />
                    <div className="flex-1">
                      <div className="flex items-baseline gap-2">
                        <span
                          className={`font-semibold ${isAgent ? "text-indigo-600" : "text-gray-800"}`}
                        >
                          {msg.author_name}
                        </span>
                        <span className="text-xs text-gray-400">
                          {formatTime(msg.created_at)}
                        </span>
                      </div>
                      <div className="mt-1 text-gray-700 leading-relaxed">
                        {renderContent(msg.content)}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="pl-[52px]">
                    <div className="text-gray-700 leading-relaxed">
                      {renderContent(msg.content)}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
        {/* 流式消息气泡 */}
        {Array.from(streamingMessages.values()).map((sm) => {
          const agent = members.find((m) => m.id === sm.agentId);
          return (
            <div key={`streaming-${sm.agentId}`} className="mb-4">
              <div className="flex gap-3">
                <img
                  src={`https://api.dicebear.com/7.x/bottts/svg?seed=${sm.agentId}`}
                  alt={agent?.name || "Agent"}
                  className="w-10 h-10 rounded-full bg-gray-100"
                />
                <div className="flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold text-indigo-600">
                      {agent?.name || "Agent"}
                    </span>
                    <span className="text-xs text-gray-400">typing...</span>
                  </div>
                  <div className="mt-1 text-gray-700 leading-relaxed">
                    {sm.content || (
                      <span className="inline-block w-2 h-4 bg-indigo-400 animate-pulse" />
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入框 */}
      <div className="px-6 pb-6">
        <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={`在项目「${currentProjectName}」中发消息，使用 @ 提及Agent...`}
            className="w-full bg-transparent text-gray-800 placeholder-gray-400 resize-none outline-none min-h-[60px]"
            rows={2}
          />

          {showMentions && (
            <MentionDropdown
              members={members}
              query={mentionQuery}
              onSelect={handleMentionSelect}
              position={mentionPosition}
            />
          )}

          <div className="flex justify-between items-center mt-2">
            <div className="flex items-center gap-2">
              <button className="p-2 text-gray-400 hover:bg-gray-200 rounded-lg transition-colors">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                  <line x1="9" y1="9" x2="9.01" y2="9" />
                  <line x1="15" y1="9" x2="15.01" y2="9" />
                </svg>
              </button>
              <button className="p-2 text-gray-400 hover:bg-gray-200 rounded-lg transition-colors">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
            </div>

            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Send size={16} />
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
