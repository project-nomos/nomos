/**
 * Setup wizard layout — renders fullscreen, overlaying the default sidebar.
 * Uses fixed positioning so the root layout's sidebar is hidden behind it.
 */
export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-base flex items-center justify-center p-4 overflow-y-auto">
      {children}
    </div>
  );
}
