import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Chain Studio · Campus Chaos",
  description:
    "A creative workspace for building, testing, and refining AI prompt chains.",
};
const themeScript = `try{var t=localStorage.getItem('chain-studio-theme')||'system';document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;}catch(e){}`;
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
