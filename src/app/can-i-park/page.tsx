import Navbar from "@/components/layout/Navbar";
import ParkingCheck from "@/components/parking-check/ParkingCheck";

export const metadata = {
  title: "Can I Park Here? — Park Off",
};

export default function CanIParkPage() {
  return (
    <div className="flex min-h-screen flex-col bg-gray-50 text-gray-900">
      <Navbar />

      <main className="flex-1 px-4 py-10">
        <div className="mx-auto max-w-md">
          <div className="mb-8 text-center">
            <span className="inline-block rounded-full bg-green-100 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-green-700">
              Instant Answer
            </span>
            <h1 className="mt-3 text-2xl font-bold text-gray-900">Can I Park Here?</h1>
            <p className="mt-2 text-sm leading-relaxed text-gray-500">
              Point your camera at the nearest parking sign and get an instant plain-English answer.
            </p>
          </div>

          <ParkingCheck />
        </div>
      </main>
    </div>
  );
}
