import { DocsSidebar } from "@/components/docs/docs-sidebar";
import "@/components/docs/docs.css";
import type { ReactNode } from "react";

export default function DocsLayout({
  children,
}: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <main id="main-content" className="docs-route mandate-docs">
      <div className="page-container">
        <div className="docs-layout">
          <DocsSidebar />
          {children}
        </div>
      </div>
    </main>
  );
}
