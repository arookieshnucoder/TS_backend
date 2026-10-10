/**
 * session的持久化方法对应的实体定义，包括ID、标题和创建时间。
 */
export interface ChatSession {
  id: string; // TODO: 雪花算法实现id作为主键
  title: string;
  createdAt: Date;
}
