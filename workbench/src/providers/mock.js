// 离线 mock：回显输入。用于流程验证，不需要任何 API key
export async function mockProvider({ input }) {
  return `MOCK-REPLY: ${input}`;
}
