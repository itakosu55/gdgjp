import { Form, Link, redirect } from "react-router";
import { EmptyState, Field, Page, selectClassName } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { requireUser } from "~/lib/auth-redirect.server";
import {
  BUS_KIND_LABELS,
  CATEGORY_LABELS,
  CONNECTOR_LABELS,
  INTERNAL_ROUTING_LABELS,
  LEVEL_LABELS,
  PHANTOM_LABELS,
  SIGNAL_LABELS,
  entries,
} from "~/lib/av/labels";
import type {
  BusKind,
  ConnectorKind,
  DeviceCategory,
  DeviceModel,
  DeviceModelPort,
  LevelKind,
  PhantomRole,
  SignalKind,
} from "~/lib/av/types";
import {
  createBus,
  createPort,
  deleteBus,
  deletePort,
  getModel,
  softDeleteModel,
  toggleDefaultRoute,
  updateModel,
} from "~/lib/db";
import type { Route } from "./+types/models.$modelId";

export function meta({ data }: Route.MetaArgs) {
  return [{ title: data ? `${data.model.name} — 型番カタログ` : "型番カタログ" }];
}

export async function loader(args: Route.LoaderArgs) {
  const env = args.context.cloudflare.env;
  const user = await requireUser(env, args.request);
  const model = await getModel(env.DB, args.params.modelId);
  if (!model) throw new Response("Not found", { status: 404 });
  return {
    user: { name: user.name, email: user.email, image: user.image },
    model,
  };
}

export async function action(args: Route.ActionArgs) {
  const env = args.context.cloudflare.env;
  await requireUser(env, args.request);
  const modelId = args.params.modelId;
  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");

  switch (intent) {
    case "update-model":
      await updateModel(env.DB, modelId, {
        maker: emptyToNull(form.get("maker")),
        name: String(form.get("name") ?? "").trim() || "(無題)",
        category: String(form.get("category") ?? "generic") as DeviceCategory,
        internalRouting: String(
          form.get("internalRouting") ?? "none",
        ) as DeviceModel["internalRouting"],
        notes: emptyToNull(form.get("notes")),
      });
      return null;

    case "delete-model":
      await softDeleteModel(env.DB, modelId);
      return redirect("/models");

    case "add-bus": {
      const key = slug(form.get("busKey"));
      if (!key) return { error: "バスのキーは必須です。" };
      await createBus(env.DB, modelId, {
        key,
        label: String(form.get("busLabel") ?? "").trim() || key.toUpperCase(),
        kind: String(form.get("busKind") ?? "aux") as BusKind,
      });
      return null;
    }

    case "delete-bus":
      await deleteBus(env.DB, modelId, String(form.get("busKey") ?? ""));
      return null;

    case "add-port": {
      const key = slug(form.get("portKey"));
      if (!key) return { error: "端子のキーは必須です。" };
      const direction = String(form.get("direction") ?? "in") as DeviceModelPort["direction"];
      await createPort(env.DB, modelId, {
        key,
        label: String(form.get("portLabel") ?? "").trim() || key.toUpperCase(),
        direction,
        signal: String(form.get("signal") ?? "audio_analog") as SignalKind,
        connector: String(form.get("connector") ?? "none") as ConnectorKind,
        level: (emptyToNull(form.get("level")) as LevelKind | null) ?? null,
        channels: Number(form.get("channels") ?? 1) || 1,
        phantom: String(form.get("phantom") ?? "none") as PhantomRole,
        // Only outputs belong to a bus; an input's routing is the matrix.
        busKey: direction === "out" ? emptyToNull(form.get("busKey")) : null,
      });
      return null;
    }

    case "delete-port":
      await deletePort(env.DB, modelId, String(form.get("portKey") ?? ""));
      return null;

    case "toggle-default-route":
      await toggleDefaultRoute(
        env.DB,
        modelId,
        String(form.get("inPort") ?? ""),
        String(form.get("bus") ?? ""),
      );
      return null;

    default:
      return { error: `不明な操作です: ${intent}` };
  }
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

function slug(value: FormDataEntryValue | null): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
}

export default function ModelDetailPage({ loaderData, actionData }: Route.ComponentProps) {
  const { model } = loaderData;
  const inputs = model.ports.filter((port) => port.direction === "in");
  const outputs = model.ports.filter((port) => port.direction === "out");
  const enabled = new Set(model.defaultRoutes.map((route) => `${route.inPort}::${route.bus}`));

  return (
    <Page
      user={loaderData.user}
      title={model.maker ? `${model.maker} ${model.name}` : model.name}
      description={CATEGORY_LABELS[model.category]}
      breadcrumb={
        <Link to="/models" className="hover:underline">
          ← 型番カタログ
        </Link>
      }
      wide
    >
      {actionData?.error ? (
        <p className="mb-4 text-sm text-destructive">{actionData.error}</p>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-8">
          <section>
            <h2 className="mb-3 text-sm font-semibold">端子</h2>
            {model.ports.length === 0 ? (
              <EmptyState>端子がまだありません。</EmptyState>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">キー</th>
                      <th className="px-3 py-2">名称</th>
                      <th className="px-3 py-2">向き</th>
                      <th className="px-3 py-2">信号</th>
                      <th className="px-3 py-2">コネクタ</th>
                      <th className="px-3 py-2">レベル</th>
                      <th className="px-3 py-2">+48V</th>
                      <th className="px-3 py-2">バス</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {model.ports.map((port) => (
                      <tr key={port.key} className="border-t">
                        <td className="px-3 py-2 font-mono text-xs">{port.key}</td>
                        <td className="px-3 py-2">{port.label}</td>
                        <td className="px-3 py-2">{port.direction === "in" ? "入力" : "出力"}</td>
                        <td className="px-3 py-2">{SIGNAL_LABELS[port.signal]}</td>
                        <td className="px-3 py-2">{CONNECTOR_LABELS[port.connector]}</td>
                        <td className="px-3 py-2">{port.level ? LEVEL_LABELS[port.level] : "—"}</td>
                        <td className="px-3 py-2">
                          {port.phantom === "none" ? "—" : PHANTOM_LABELS[port.phantom]}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{port.busKey ?? "—"}</td>
                        <td className="px-3 py-2 text-right">
                          <Form method="post">
                            <input type="hidden" name="intent" value="delete-port" />
                            <input type="hidden" name="portKey" value={port.key} />
                            <button
                              type="submit"
                              className="text-xs text-muted-foreground hover:text-destructive"
                            >
                              削除
                            </button>
                          </Form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-1 text-sm font-semibold">内部バス</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              出力端子はいずれかのバスに属します。入力からバスへの経路が構成側の
              ルーティング行列です。
            </p>
            {model.buses.length === 0 ? (
              <EmptyState>
                バスがありません。内部ルーティングが matrix の機材にだけ必要です。
              </EmptyState>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {model.buses.map((bus) => (
                  <li
                    key={bus.key}
                    className="flex items-center gap-2 rounded border px-2 py-1 text-sm"
                  >
                    <span className="font-mono text-xs">{bus.key}</span>
                    <span className="text-muted-foreground">{bus.label}</span>
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete-bus" />
                      <input type="hidden" name="busKey" value={bus.key} />
                      <button
                        type="submit"
                        className="text-xs text-muted-foreground hover:text-destructive"
                      >
                        ×
                      </button>
                    </Form>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {model.internalRouting === "matrix" && model.buses.length > 0 ? (
            <section>
              <h2 className="mb-1 text-sm font-semibold">既定ルーティング</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                構成に追加したときの初期値です。追加後は構成側が正となり、ここは参照されません。
              </p>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">入力</th>
                      {model.buses.map((bus) => (
                        <th key={bus.key} className="px-3 py-2 text-center">
                          {bus.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {inputs.map((port) => (
                      <tr key={port.key} className="border-t">
                        <td className="px-3 py-2">{port.label}</td>
                        {model.buses.map((bus) => (
                          <td key={bus.key} className="px-3 py-2 text-center">
                            <Form method="post">
                              <input type="hidden" name="intent" value="toggle-default-route" />
                              <input type="hidden" name="inPort" value={port.key} />
                              <input type="hidden" name="bus" value={bus.key} />
                              <button
                                type="submit"
                                aria-label={`${port.label} → ${bus.label}`}
                                className={
                                  enabled.has(`${port.key}::${bus.key}`)
                                    ? "size-5 rounded border border-primary bg-primary text-xs text-primary-foreground"
                                    : "size-5 rounded border border-input text-xs text-muted-foreground hover:border-ring"
                                }
                              >
                                {enabled.has(`${port.key}::${bus.key}`) ? "✓" : ""}
                              </button>
                            </Form>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          <section className="rounded-lg border p-4">
            <h2 className="mb-3 text-sm font-semibold">端子を追加</h2>
            <Form method="post" className="flex flex-col gap-3">
              <input type="hidden" name="intent" value="add-port" />
              <Field label="キー" htmlFor="portKey" hint="英数字と _ 。構成の結線から参照されます">
                <Input id="portKey" name="portKey" required placeholder="ch1" maxLength={40} />
              </Field>
              <Field label="表示名" htmlFor="portLabel">
                <Input id="portLabel" name="portLabel" placeholder="CH1" maxLength={60} />
              </Field>
              <Field label="向き" htmlFor="direction">
                <select id="direction" name="direction" className={selectClassName}>
                  <option value="in">入力</option>
                  <option value="out">出力</option>
                </select>
              </Field>
              <Field label="信号" htmlFor="signal">
                <select id="signal" name="signal" className={selectClassName}>
                  {entries(SIGNAL_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="コネクタ" htmlFor="connector">
                <select id="connector" name="connector" className={selectClassName}>
                  {entries(CONNECTOR_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="レベル" htmlFor="level">
                <select id="level" name="level" className={selectClassName}>
                  <option value="">指定しない (映像・デジタル)</option>
                  {entries(LEVEL_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="ファンタム電源" htmlFor="phantom">
                <select id="phantom" name="phantom" className={selectClassName}>
                  {entries(PHANTOM_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="所属バス (出力のみ)" htmlFor="portBusKey">
                <select id="portBusKey" name="busKey" className={selectClassName}>
                  <option value="">なし</option>
                  {model.buses.map((bus) => (
                    <option key={bus.key} value={bus.key}>
                      {bus.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="チャンネル数" htmlFor="channels">
                <Input
                  id="channels"
                  name="channels"
                  type="number"
                  min={1}
                  max={64}
                  defaultValue={1}
                />
              </Field>
              <Button type="submit">端子を追加</Button>
            </Form>
          </section>

          <section className="rounded-lg border p-4">
            <h2 className="mb-3 text-sm font-semibold">バスを追加</h2>
            <Form method="post" className="flex flex-col gap-3">
              <input type="hidden" name="intent" value="add-bus" />
              <Field label="キー" htmlFor="busKey">
                <Input id="busKey" name="busKey" required placeholder="aux1" maxLength={40} />
              </Field>
              <Field label="表示名" htmlFor="busLabel">
                <Input id="busLabel" name="busLabel" placeholder="AUX1" maxLength={60} />
              </Field>
              <Field label="種別" htmlFor="busKind">
                <select id="busKind" name="busKind" defaultValue="aux" className={selectClassName}>
                  {entries(BUS_KIND_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" variant="outline">
                バスを追加
              </Button>
            </Form>
          </section>

          <section className="rounded-lg border p-4">
            <h2 className="mb-3 text-sm font-semibold">型番の設定</h2>
            <Form method="post" className="flex flex-col gap-3">
              <input type="hidden" name="intent" value="update-model" />
              <Field label="メーカー" htmlFor="maker">
                <Input id="maker" name="maker" defaultValue={model.maker ?? ""} maxLength={80} />
              </Field>
              <Field label="型番名" htmlFor="name">
                <Input id="name" name="name" defaultValue={model.name} required maxLength={120} />
              </Field>
              <Field label="種別" htmlFor="category">
                <select
                  id="category"
                  name="category"
                  defaultValue={model.category}
                  className={selectClassName}
                >
                  {entries(CATEGORY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="内部ルーティング" htmlFor="internalRouting">
                <select
                  id="internalRouting"
                  name="internalRouting"
                  defaultValue={model.internalRouting}
                  className={selectClassName}
                >
                  {entries(INTERNAL_ROUTING_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" variant="outline">
                保存
              </Button>
            </Form>
            <Form method="post" className="mt-3">
              <input type="hidden" name="intent" value="delete-model" />
              <button
                type="submit"
                className="text-xs text-muted-foreground hover:text-destructive"
              >
                この型番を削除
              </button>
            </Form>
          </section>
        </div>
      </div>

      <p className="mt-8 text-xs text-muted-foreground">
        出力端子 {outputs.length} / 入力端子 {inputs.length}
      </p>
    </Page>
  );
}
