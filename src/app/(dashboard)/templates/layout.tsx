// Vendored xterm CSS — imported here (app/ entrypoint) because Next.js only
// allows global CSS imports from app/ layouts, not from component files.
// @xterm/xterm uses the "style" export condition which Turbopack cannot resolve.
import "@/styles/xterm.css";

export default function TemplatesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
