// Vite asset imports the page uses.

declare module "*?worker&url" {
  const url: string;
  export default url;
}
