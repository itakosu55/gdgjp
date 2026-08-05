import { Form, Link, redirect } from "react-router";
import { EmptyState, Field, Page } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { requireUser } from "~/lib/auth-redirect.server";
import { CATEGORY_LABELS } from "~/lib/av/labels";
import type { DeviceCategory } from "~/lib/av/types";
import {
  createSetup,
  getEvent,
  listEventDeviceIds,
  listLedger,
  listSetups,
  softDeleteEvent,
  softDeleteSetup,
  toggleEventDevice,
  updateEvent,
} from "~/lib/db";
import {
  emptyToNull,
  formatEventDate,
  parseLocalDateTime,
  text,
  toLocalDateTimeValue,
} from "~/lib/form";
import type { Route } from "./+types/events.$eventId";

export function meta({ data }: Route.MetaArgs) {
  return [{ title: data ? `${data.event.title} — Stream` : "イベント — Stream" }];
}

export async function loader(args: Route.LoaderArgs) {
  const env = args.context.cloudflare.env;
  const user = await requireUser(env, args.request);
  const event = await getEvent(env.DB, args.params.eventId);
  if (!event) throw new Response("Not found", { status: 404 });

  const [ledger, selected, setups] = await Promise.all([
    listLedger(env.DB),
    listEventDeviceIds(env.DB, event.id),
    listSetups(env.DB, event.id),
  ]);

  return {
    user: { name: user.name, email: user.email, image: user.image },
    event,
    ledger,
    selectedDeviceIds: [...selected],
    setups: setups.map((setup) => ({
      id: setup.id,
      name: setup.name,
      nodeCount: setup.doc.nodes.length,
      linkCount: setup.doc.links.length,
      docError: setup.docError,
    })),
  };
}

export async function action(args: Route.ActionArgs) {
  const env = args.context.cloudflare.env;
  const user = await requireUser(env, args.request);
  const eventId = args.params.eventId;
  const form = await args.request.formData();

  switch (text(form.get("intent"))) {
    case "update-event":
      await updateEvent(env.DB, eventId, {
        title: text(form.get("title")) || "(無題)",
        startsAt: parseLocalDateTime(form.get("startsAt")),
        venue: emptyToNull(form.get("venue")),
        externalUrl: emptyToNull(form.get("externalUrl")),
      });
      return null;

    case "delete-event":
      await softDeleteEvent(env.DB, eventId);
      return redirect("/events");

    case "toggle-device":
      await toggleEventDevice(env.DB, eventId, text(form.get("deviceId")));
      return null;

    case "create-setup": {
      const name = text(form.get("name"));
      if (!name) return { error: "構成名は必須です。" };
      const id = await createSetup(env.DB, eventId, name, user.id);
      return redirect(`/events/${eventId}/setups/${id}`);
    }

    case "delete-setup":
      await softDeleteSetup(env.DB, text(form.get("setupId")));
      return null;

    default:
      return { error: "不明な操作です。" };
  }
}

export default function EventDetailPage({ loaderData, actionData }: Route.ComponentProps) {
  const { event, ledger, selectedDeviceIds, setups } = loaderData;
  const selected = new Set(selectedDeviceIds);
  const byCategory = new Map<DeviceCategory, typeof ledger>();
  for (const device of ledger) {
    const list = byCategory.get(device.category);
    if (list) list.push(device);
    else byCategory.set(device.category, [device]);
  }

  return (
    <Page
      user={loaderData.user}
      title={event.title}
      description={`${formatEventDate(event.startsAt)}${event.venue ? ` / ${event.venue}` : ""}`}
      breadcrumb={
        <Link to="/events" className="hover:underline">
          ← イベント
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
            <h2 className="mb-1 text-sm font-semibold">構成</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              同時に成立しない代替案（本番 / リハ / プラン B）を並べます。同時並行する別トラックは
              まだ扱えません。
            </p>
            {setups.length === 0 ? (
              <EmptyState>まだ構成がありません。右のフォームから作成してください。</EmptyState>
            ) : (
              <ul className="flex flex-col gap-2">
                {setups.map((setup) => (
                  <li
                    key={setup.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-4"
                  >
                    <Link
                      to={`/events/${event.id}/setups/${setup.id}`}
                      className="font-medium hover:underline"
                    >
                      {setup.name}
                    </Link>
                    <div className="flex items-center gap-4">
                      <span className="text-sm text-muted-foreground">
                        機材 {setup.nodeCount} / 結線 {setup.linkCount}
                      </span>
                      {setup.docError ? (
                        <span className="text-xs text-destructive">{setup.docError}</span>
                      ) : null}
                      <Form method="post">
                        <input type="hidden" name="intent" value="delete-setup" />
                        <input type="hidden" name="setupId" value={setup.id} />
                        <button
                          type="submit"
                          className="text-xs text-muted-foreground hover:text-destructive"
                        >
                          削除
                        </button>
                      </Form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="mb-1 text-sm font-semibold">利用可能機材</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              当日ここに持ち込む機材です。構成で使えるのはここで選んだものだけで、外れていると
              Linter が <code>device-not-in-event</code> を報告します。
            </p>
            {ledger.length === 0 ? (
              <EmptyState>
                <Link to="/devices" className="underline">
                  機材台帳
                </Link>
                に機材を登録してください。
              </EmptyState>
            ) : (
              <div className="flex flex-col gap-4">
                {[...byCategory.entries()].map(([category, devices]) => (
                  <div key={category}>
                    <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                      {CATEGORY_LABELS[category]}
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {devices.map((device) => (
                        <Form method="post" key={device.id}>
                          <input type="hidden" name="intent" value="toggle-device" />
                          <input type="hidden" name="deviceId" value={device.id} />
                          <button
                            type="submit"
                            aria-pressed={selected.has(device.id)}
                            className={
                              selected.has(device.id)
                                ? "rounded-full border border-primary bg-primary px-3 py-1 text-sm text-primary-foreground"
                                : "rounded-full border border-input px-3 py-1 text-sm text-muted-foreground hover:border-ring"
                            }
                          >
                            {device.name}
                          </button>
                        </Form>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="flex flex-col gap-6">
          <section className="rounded-lg border p-4">
            <h2 className="mb-3 text-sm font-semibold">構成を作成</h2>
            <Form method="post" className="flex flex-col gap-3">
              <input type="hidden" name="intent" value="create-setup" />
              <Field label="構成名" htmlFor="setupName">
                <Input id="setupName" name="name" required placeholder="本番構成" maxLength={120} />
              </Field>
              <Button type="submit">作成</Button>
            </Form>
          </section>

          <section className="rounded-lg border p-4">
            <h2 className="mb-3 text-sm font-semibold">イベント情報</h2>
            <Form method="post" className="flex flex-col gap-3">
              <input type="hidden" name="intent" value="update-event" />
              <Field label="タイトル" htmlFor="title">
                <Input id="title" name="title" defaultValue={event.title} maxLength={200} />
              </Field>
              <Field label="開始日時" htmlFor="startsAt">
                <Input
                  id="startsAt"
                  name="startsAt"
                  type="datetime-local"
                  defaultValue={toLocalDateTimeValue(event.startsAt)}
                />
              </Field>
              <Field label="会場" htmlFor="venue">
                <Input id="venue" name="venue" defaultValue={event.venue ?? ""} maxLength={200} />
              </Field>
              <Field label="関連 URL" htmlFor="externalUrl">
                <Input
                  id="externalUrl"
                  name="externalUrl"
                  type="url"
                  defaultValue={event.externalUrl ?? ""}
                  maxLength={500}
                />
              </Field>
              <Button type="submit" variant="secondary">
                保存
              </Button>
            </Form>
            <Form method="post" className="mt-3">
              <input type="hidden" name="intent" value="delete-event" />
              <button
                type="submit"
                className="text-xs text-muted-foreground hover:text-destructive"
              >
                このイベントを削除
              </button>
            </Form>
          </section>
        </div>
      </div>
    </Page>
  );
}
