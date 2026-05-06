import Link from "next/link";
import Navbar from "@/components/layout/Navbar";
import ParkingMap from "@/components/map/ParkingMap";

const STEPS = [
  { icon: "🗺️", title: "Search a location", body: "Type any Halifax address or neighbourhood to pan the map." },
  { icon: "📍", title: "Find nearby parking", body: "Tap a colour-coded pin to see type, time limit, cost, and street." },
  { icon: "🧭", title: "Get directions", body: "One tap opens Google Maps with turn-by-turn directions to the spot." },
];

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col bg-white text-gray-900">
      <Navbar />

      {/* ── Full-screen map ─────────────────────────────────────────────── */}
      <section className="relative" style={{ height: "calc(100dvh - 60px)" }}>
        <ParkingMap />

        {/* Scroll hint — only visible on larger screens where content exists below */}
        <div className="pointer-events-none absolute bottom-4 right-4 z-10 hidden rounded-full bg-white/80 px-3 py-1.5 text-xs text-gray-500 shadow-sm backdrop-blur-sm sm:block">
          Scroll for more ↓
        </div>
      </section>

      {/* ── Below the fold ──────────────────────────────────────────────── */}
      <section id="how-it-works" className="bg-gray-50 px-5 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-center text-xl font-bold text-gray-900">How it works</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.title} className="rounded-2xl bg-white p-6 shadow-sm">
                <div className="text-3xl">{s.icon}</div>
                <h3 className="mt-3 font-semibold text-gray-900">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-gray-500">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Contribute CTA ──────────────────────────────────────────────── */}
      <section className="px-5 py-14">
        <div className="mx-auto max-w-md rounded-2xl border border-indigo-100 bg-indigo-50 p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-indigo-100 text-2xl">📷</div>
          <h2 className="mt-5 text-lg font-bold text-gray-900">Know a parking spot we're missing?</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">
            Photograph a parking sign — our OCR reads the rules automatically. No account needed.
          </p>
          <Link
            href="/submit"
            className="mt-5 inline-block rounded-full bg-indigo-600 px-7 py-3 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
          >
            Submit a sign
          </Link>
        </div>
      </section>

      <footer className="border-t border-gray-100 py-6 text-center text-xs text-gray-400">
        Park Off · Halifax parking, community powered
      </footer>
    </div>
  );
}
