import { Link } from "react-router";
import { Header } from "~/components/header";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { getOptionalUser } from "~/lib/auth-redirect.server";
import type { Route } from "./+types/home";

export function meta() {
  return [
    { title: "Stream — 配信・音響機材の構成" },
    {
      name: "description",
      content: "イベントの配信・音響機材の構成を登録し、ハウリングやエコーの問題を検査します。",
    },
  ];
}

export async function loader(args: Route.LoaderArgs) {
  const user = await getOptionalUser(args.context.cloudflare.env, args.request);
  return {
    user: user ? { name: user.name, email: user.email, image: user.image } : null,
  };
}

const SECTIONS = [
  {
    to: "/events",
    title: "イベント",
    body: "配信回ごとに、持ち込む機材を機材台帳から選び、その範囲で構成を組みます。",
  },
  {
    to: "/devices",
    title: "機材台帳",
    body: "実物 1 台ごとに登録する共有プールです。誰が持っていても全員から参照できます。",
  },
  {
    to: "/models",
    title: "型番カタログ",
    body: "入出力端子・内部バス・既定ルーティングを型番ごとに定義します。",
  },
] as const;

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <div className="min-h-dvh">
      <Header user={loaderData.user} />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">配信・音響機材の構成</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            機材の結線とミキサーのルーティングを登録すると、ハウリング・リモート登壇者への
            エコー返り・配信の無音を事前に検出します。
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {SECTIONS.map((section) => (
            <Link key={section.to} to={section.to} className="group">
              <Card className="h-full transition-colors group-hover:border-ring">
                <CardHeader>
                  <CardTitle className="text-base">{section.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">{section.body}</CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
