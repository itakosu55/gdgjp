import { Form, Link, redirect } from "react-router";
import { EmptyState, Field, Page, selectClassName } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { requireUser } from "~/lib/auth-redirect.server";
import { CATEGORY_LABELS, INTERNAL_ROUTING_LABELS, entries } from "~/lib/av/labels";
import type { DeviceCategory, DeviceModel } from "~/lib/av/types";
import { createModel, listModels } from "~/lib/db";
import type { Route } from "./+types/models";

export function meta() {
  return [{ title: "型番カタログ — Stream" }];
}

export async function loader(args: Route.LoaderArgs) {
  const env = args.context.cloudflare.env;
  const user = await requireUser(env, args.request);
  return {
    user: { name: user.name, email: user.email, image: user.image },
    models: await listModels(env.DB),
  };
}

export async function action(args: Route.ActionArgs) {
  const env = args.context.cloudflare.env;
  const user = await requireUser(env, args.request);
  const form = await args.request.formData();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "型番名は必須です。" };

  const id = await createModel(
    env.DB,
    {
      maker: emptyToNull(form.get("maker")),
      name,
      category: String(form.get("category") ?? "generic") as DeviceCategory,
      internalRouting: String(
        form.get("internalRouting") ?? "none",
      ) as DeviceModel["internalRouting"],
      echoCancels: form.has("echoCancels"),
      notes: emptyToNull(form.get("notes")),
    },
    user.id,
  );
  return redirect(`/models/${id}`);
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

export default function ModelsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { models } = loaderData;

  return (
    <Page
      user={loaderData.user}
      title="型番カタログ"
      description="入出力端子・内部バス・既定ルーティングを型番ごとに定義します。ここに登録した型番から機材台帳のレコードを作ります。"
      wide
    >
      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        <section>
          {models.length === 0 ? (
            <EmptyState>まだ型番がありません。右のフォームから追加してください。</EmptyState>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>型番</TableHead>
                    <TableHead>種別</TableHead>
                    <TableHead className="text-right">端子</TableHead>
                    <TableHead className="text-right">バス</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {models.map((model) => (
                    <TableRow key={model.id}>
                      <TableCell>
                        <Link to={`/models/${model.id}`} className="font-medium hover:underline">
                          {model.maker ? `${model.maker} ` : ""}
                          {model.name}
                        </Link>
                        <div className="text-xs text-muted-foreground">{model.internalRouting}</div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {CATEGORY_LABELS[model.category]}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {model.ports.length}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {model.buses.length}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-sm font-semibold">型番を追加</h2>
          <Form method="post" className="flex flex-col gap-3">
            <Field label="メーカー" htmlFor="maker">
              <Input id="maker" name="maker" placeholder="YAMAHA" maxLength={80} />
            </Field>
            <Field label="型番名" htmlFor="name">
              <Input id="name" name="name" required placeholder="MG10XU" maxLength={120} />
            </Field>
            <Field label="種別" htmlFor="category">
              <select id="category" name="category" className={selectClassName}>
                {entries(CATEGORY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="内部ルーティング"
              htmlFor="internalRouting"
              hint="会議ソフトは必ず none にしてください。入力を出力へ通すと、存在しないエコー閉路が検出されます。"
            >
              <select
                id="internalRouting"
                name="internalRouting"
                defaultValue="none"
                className={selectClassName}
              >
                {entries(INTERNAL_ROUTING_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="エコーキャンセラを内蔵する"
              htmlFor="echoCancels"
              hint="機材自身の機能(AEC)についてです。部屋の響きではありません。"
            >
              <div className="flex items-center pt-1.5 pb-1">
                <input
                  type="checkbox"
                  id="echoCancels"
                  name="echoCancels"
                  value="on"
                  className="size-4"
                />
              </div>
            </Field>
            <Field label="メモ" htmlFor="notes">
              <Input id="notes" name="notes" maxLength={200} />
            </Field>
            {actionData?.error ? (
              <p className="text-sm text-destructive">{actionData.error}</p>
            ) : null}
            <Button type="submit">追加</Button>
          </Form>
        </section>
      </div>
    </Page>
  );
}
