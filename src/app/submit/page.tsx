import Navbar from "@/components/layout/Navbar";
import SignCapture from "@/components/capture/SignCapture";

export const metadata = {
  title: "Submit a Sign — Park Off",
  description: "Help Halifax drivers by photographing a parking sign near you.",
};

export default function SubmitPage() {
  return (
    <div className="flex min-h-screen flex-col bg-white text-gray-900">
      <Navbar />

      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-md">
          {/* Header */}
          <div className="mb-8">
            <span className="inline-block rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-indigo-600">
              Community
            </span>
            <h1 className="mt-3 text-2xl font-bold text-gray-900">
              Submit a parking sign
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-gray-500">
              Take a live photo of a parking sign. We capture your location at
              the same moment to pin it on the map, then review it before it
              goes live.
            </p>
          </div>

          <SignCapture />

          <p className="mt-6 text-center text-xs text-gray-400">
            No account needed. Your submission stays pending until an admin
            approves it.
          </p>
        </div>
      </main>
    </div>
  );
}
