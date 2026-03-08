// [问题18] 统一的状态颜色工具函数
export function getStatusColor(status: string): string {
  switch (status) {
    case 'online': return 'bg-green-500'
    case 'working': return 'bg-yellow-500 animate-pulse'
    case 'idle': return 'bg-green-500'
    default: return 'bg-gray-400'
  }
}
