// Domain data has no Express or storage dependencies.
export interface ChatSession {
  id: string;
  title: string;
  createdAt: Date;
}
