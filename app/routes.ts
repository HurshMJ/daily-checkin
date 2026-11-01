import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("healthz", "routes/healthz.ts"),
  route("setup/:token", "routes/setup.$token.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.ts"),
  route("logout-everywhere", "routes/logout-everywhere.ts"),
  route("profile", "routes/profile.tsx"),
] satisfies RouteConfig;
