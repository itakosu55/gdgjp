import { Form, Link, redirect } from "react-router";
import { EmptyState, Field, Page } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { requireUser } from "~/lib/auth-redirect.server";
import { createEvent, listEvents } from "~/lib/db";
import { emptyToNull, formatEventDate, parseLocalDateTime, text } from "~/lib/form";
import type { Route } from "./+types/events";

export function meta() {
  return [{ title: "イベント — Stream" }];
}

export async function loader(args: Route.LoaderArgs) {
  const env = args.context.cloudflare.env;
  const user = await requireUser(env, args.request);
  return {
    user: { name: user.name, email: user.email, image: user.image },
    events: await listEvents(env.DB),
  };
}

export async function action(args: Route.ActionArgs) {
  const env = args.context.cloudflare.env;
  const user = await requireUser(env, args.request);
  const form = await args.request.formData();
  const title = text(form.get("title"));
  if (!title) return { error: "タイトルは必須です。" };

  const id = await createEvent(
    env.DB,
    {
      title,
      startsAt: parseLocalDateTime(form.get("startsAt")),
      venue: emptyToNull(form.get("venue")),
      externalUrl: emptyToNull(form.get("externalUrl")),
    },
    user.id,
  );
  return redirect(`/events/${id}`);
}

export default function EventsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { events } = loaderData;

  return (
    <Page
      user={loaderData.user}
      title="イベント"
      description="配信回ごとに、持ち込む機材を機材台帳から選び、その範囲で構成を組みます。"
      wide
    >
      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        <section>
          {events.length === 0 ? (
            <EmptyState>まだイベントがありません。右のフォームから追加してください。</EmptyState>
          ) : (
            <ul className="flex flex-col gap-2">
              {events.map((event) => (
                <li key={event.id}>
                  <Link
                    to={`/events/${event.id}`}
                    className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border p-4 hover:border-ring"
                  >
                    <span className="font-medium">{event.title}</span>
                    <span className="text-sm text-muted-foreground">
                      {formatEventDate(event.startsAt)}
                      {event.venue ? ` / ${event.venue}` : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-sm font-semibold">イベントを追加</h2>
          <Form method="post" className="flex flex-col gap-3">
            <Field label="タイトル" htmlFor="title">
              <Input id="title" name="title" required placeholder="DevFest Tokyo" maxLength={200} />
            </Field>
            <Field label="開始日時" htmlFor="startsAt" hint="日本時間で解釈します。">
              <Input id="startsAt" name="startsAt" type="datetime-local" />
            </Field>
            <Field label="会場" htmlFor="venue">
              <Input id="venue" name="venue" maxLength={200} />
            </Field>
            <Field label="関連 URL" htmlFor="externalUrl" hint="connpass や運営ドキュメントなど。">
              <Input id="externalUrl" name="externalUrl" type="url" maxLength={500} />
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
