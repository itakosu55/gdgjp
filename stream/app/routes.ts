import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("events", "routes/events.tsx"),
  route("events/:eventId", "routes/events.$eventId.tsx"),
  route("events/:eventId/setups/:setupId", "routes/events.$eventId.setups.$setupId.tsx"),
  route("devices", "routes/devices.tsx"),
  route("models", "routes/models.tsx"),
  route("models/:modelId", "routes/models.$modelId.tsx"),
  route("signin", "routes/signin.tsx"),
  route("api/auth/*", "routes/api.auth.$.ts"),
  route("auth/signout", "routes/auth.signout.ts"),
] satisfies RouteConfig;
