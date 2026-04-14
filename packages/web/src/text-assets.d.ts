// Declare text asset module types for bun's `with { type: 'text' }` imports
declare module '*.html' {
  const content: string;
  export default content;
}
declare module '*.md' {
  const content: string;
  export default content;
}
declare module '*.yaml' {
  const content: string;
  export default content;
}
