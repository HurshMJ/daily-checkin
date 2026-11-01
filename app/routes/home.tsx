import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Daily Check-in" }];
}

export default function Home() {
  return (
    <main>
      <h1>Daily Check-in</h1>
      <p>Who is on for tonight? Check-ins are coming soon.</p>
    </main>
  );
}
