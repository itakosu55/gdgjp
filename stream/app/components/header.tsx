import { GdgAccountMenu, GdgAppLauncher } from "@gdgjp/gdg-lib/ui";
import { Link } from "react-router";
import { GdgMark } from "~/components/gdg-mark";
import { ThemeToggle } from "~/components/theme-toggle";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export type HeaderUser = { name: string; email: string; image: string | null };

const NAV = [
  { to: "/events", label: "イベント" },
  { to: "/devices", label: "機材台帳" },
  { to: "/models", label: "型番カタログ" },
] as const;

export function Header({
  user,
  fluid,
}: {
  user: HeaderUser | null;
  /** Full bleed, for the setup editor — a centred bar over a four-region shell reads as a second page. */
  fluid?: boolean;
}) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div
        className={cn(
          "mx-auto flex items-center justify-between gap-4 px-4 py-3",
          fluid ? "max-w-none" : "max-w-6xl",
        )}
      >
        <div className="flex min-w-0 items-center gap-5">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <GdgMark size="sm" />
            <span className="text-lg font-semibold tracking-tight">Stream</span>
          </Link>
          {user ? (
            // Scrolls rather than wraps: a wrapped nav grows the bar to two
            // lines and, with nothing holding the brand's width, runs under it.
            <nav className="flex min-w-0 items-center gap-4 overflow-x-auto text-sm text-muted-foreground">
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="whitespace-nowrap hover:text-foreground"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          ) : null}
        </div>
        <nav className="flex items-center gap-1 text-sm">
          <ThemeToggle />
          {user ? (
            <>
              <GdgAppLauncher />
              <GdgAccountMenu
                accountUrl="https://accounts.gdgs.jp/dashboard"
                onSignOut={() => window.location.assign("/auth/signout")}
                user={user}
              />
            </>
          ) : (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/signin">Sign in</Link>
            </Button>
          )}
        </nav>
      </div>
    </header>
  );
}
