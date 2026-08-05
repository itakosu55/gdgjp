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
import { CATEGORY_LABELS } from "~/lib/av/labels";
import { createDevice, listLedger, listModels, softDeleteDevice } from "~/lib/db";
import { emptyToNull, text } from "~/lib/form";
import type { Route } from "./+types/devices";

export function meta() {
  return [{ title: "機材台帳 — Stream" }];
}

export async function loader(args: Route.LoaderArgs) {
  const env = args.context.cloudflare.env;
  const user = await requireUser(env, args.request);
  const [devices, models] = await Promise.all([listLedger(env.DB), listModels(env.DB)]);
  return {
    user: { name: user.name, email: user.email, image: user.image },
    devices,
    models: models.map((model) => ({
      id: model.id,
      label: model.maker ? `${model.maker} ${model.name}` : model.name,
      category: model.category,
    })),
  };
}

export async function action(args: Route.ActionArgs) {
  const env = args.context.cloudflare.env;
  const user = await requireUser(env, args.request);
  const form = await args.request.formData();

  if (String(form.get("intent")) === "delete") {
    await softDeleteDevice(env.DB, String(form.get("deviceId") ?? ""));
    return null;
  }

  const modelId = text(form.get("modelId"));
  const name = text(form.get("name"));
  if (!modelId) return { error: "型番を選んでください。" };
  if (!name) return { error: "機材名は必須です。" };

  await createDevice(
    env.DB,
    {
      modelId,
      name,
      identifier: emptyToNull(form.get("identifier")),
      ownerNote: emptyToNull(form.get("ownerNote")),
    },
    user.id,
  );
  return redirect("/devices");
}

export default function DevicesPage({ loaderData, actionData }: Route.ComponentProps) {
  const { devices, models } = loaderData;

  return (
    <Page
      user={loaderData.user}
      title="機材台帳"
      description="実物 1 台ごとに 1 レコードです。チャプターには紐づかず、サインインした全員で共有します。同じ型番を 2 台持っているなら 2 レコード登録してください。"
      wide
    >
      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        <section>
          {models.length === 0 ? (
            <EmptyState>
              先に{" "}
              <Link to="/models" className="underline">
                型番カタログ
              </Link>{" "}
              に型番を登録してください。
            </EmptyState>
          ) : devices.length === 0 ? (
            <EmptyState>まだ機材がありません。右のフォームから追加してください。</EmptyState>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>機材</TableHead>
                    <TableHead>型番</TableHead>
                    <TableHead>種別</TableHead>
                    <TableHead>所有メモ</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {devices.map((device) => (
                    <TableRow key={device.id}>
                      <TableCell>
                        <div className="font-medium">{device.name}</div>
                        {device.identifier ? (
                          <div className="text-xs text-muted-foreground">
                            目印: {device.identifier}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {device.modelMaker ? `${device.modelMaker} ` : ""}
                        {device.modelName}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {CATEGORY_LABELS[device.category]}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {device.ownerNote ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Form method="post">
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="deviceId" value={device.id} />
                          <button
                            type="submit"
                            className="text-xs text-muted-foreground hover:text-destructive"
                          >
                            削除
                          </button>
                        </Form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-sm font-semibold">機材を追加</h2>
          <Form method="post" className="flex flex-col gap-3">
            <Field label="型番" htmlFor="modelId">
              <select id="modelId" name="modelId" required className={selectClassName}>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="機材名" htmlFor="name" hint="同じ型番が複数あるので個体が分かる名前に。">
              <Input id="name" name="name" required placeholder="MG10XU #1" maxLength={120} />
            </Field>
            <Field label="現物の目印" htmlFor="identifier" hint="青シール、資産番号など。">
              <Input id="identifier" name="identifier" maxLength={80} />
            </Field>
            <Field
              label="所有メモ"
              htmlFor="ownerNote"
              hint="単なるメモです。閲覧・利用の制限にはなりません。"
            >
              <Input
                id="ownerNote"
                name="ownerNote"
                placeholder="東京チャプター備品"
                maxLength={120}
              />
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
