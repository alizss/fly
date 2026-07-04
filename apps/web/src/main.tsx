import React, { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion } from "framer-motion";
import {
  BadgeCheck,
  BriefcaseBusiness,
  CalendarDays,
  CircleAlert,
  Clock3,
  Luggage,
  MapPinned,
  Plane,
  Radar,
  ReceiptText,
  Settings,
  Sparkles,
  UserRound,
  UsersRound
} from "lucide-react";
import "./styles.css";

const API = "/api";

type Workspace = {
  id: string;
  name: string;
};

type TravelerDocument = {
  document_type: string;
  issuing_country: string;
  masked_document_number: string;
  expiry_date: string;
};

type Traveler = {
  id: string;
  workspace_id: string;
  first_name: string;
  middle_name?: string;
  last_name: string;
  date_of_birth: string;
  gender: string;
  nationality: string;
  email: string;
  phone: string;
  preferred_seat: string;
  baggage_preference: string;
  default_cabin: string;
  invoice_company?: string;
  billing_tax_id?: string;
  billing_address?: string;
  billing_email?: string;
  payment_preference?: string;
  booking_rules?: string;
  document?: TravelerDocument | null;
};

type Trip = {
  id: string;
  workspace_id: string;
  traveler_profile_id: string;
  airline: string;
  seller: string;
  origin_airport: string;
  destination_airport: string;
  departure_at: string;
  return_at?: string;
  booking_reference?: string;
  price_amount?: number;
  price_currency?: string;
  baggage_summary?: string;
  invoice_status: string;
  warnings?: string[];
};

type Member = {
  email: string;
  role: string;
};

type Invite = {
  email: string;
  role: string;
};

type Bootstrap = {
  workspaces: Workspace[];
  travelers: Traveler[];
  trips: Trip[];
  members: Member[];
  invites: Invite[];
  preferences: {
    selected_traveler_id?: string;
  };
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { "content-type": "application/json" },
    ...options
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

function useHashRoute() {
  const [route, setRoute] = useState(location.hash || "#/dashboard");
  useEffect(() => {
    const onHashChange = () => setRoute(location.hash || "#/dashboard");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route.replace(/^#/, "") || "/dashboard";
}

function travelerName(traveler?: Traveler | null) {
  return [traveler?.first_name, traveler?.middle_name, traveler?.last_name].filter(Boolean).join(" ") || "Traveler";
}

function fmtDate(value?: string) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function formData(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget).entries());
}

function App() {
  const route = useHashRoute();
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    setData(await api<Bootstrap>("/bootstrap"));
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

  const selectedTraveler = useMemo(() => {
    if (!data) return null;
    return data.travelers.find((traveler) => traveler.id === data.preferences?.selected_traveler_id) || data.travelers[0];
  }, [data]);

  const title = pageTitle(route);

  if (error) {
    return <ErrorState message={error} />;
  }

  if (!data || !selectedTraveler) {
    return <LoadingState />;
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_12%_0%,rgba(56,189,248,0.24),transparent_30%),radial-gradient(circle_at_80%_10%,rgba(255,107,74,0.18),transparent_28%),linear-gradient(135deg,#03040c,#08111f_48%,#0b1020)] text-slate-50">
      <div className="pointer-events-none fixed inset-0 opacity-30 [background-image:radial-gradient(circle,rgba(255,255,255,.55)_1px,transparent_1px),radial-gradient(circle,rgba(56,189,248,.38)_1px,transparent_1px)] [background-position:0_0,22px_28px] [background-size:72px_72px,110px_110px]" />
      <div className="relative grid min-h-screen lg:grid-cols-[280px_1fr]">
        <Sidebar />
        <main className="min-w-0">
          <Topbar title={title} workspace={data.workspaces[0]?.name || "Workspace"} />
          <section className="grid gap-6 px-5 py-6 md:px-8">
            <AnimatePresence mode="wait">
              <motion.div
                key={route}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22 }}
              >
                <RouteView route={route} data={data} selectedTraveler={selectedTraveler} setData={setData} refresh={refresh} />
              </motion.div>
            </AnimatePresence>
          </section>
        </main>
      </div>
    </div>
  );
}

function Sidebar() {
  const nav = [
    ["#/dashboard", "Dashboard", Radar],
    ["#/travelers", "Travelers", UsersRound],
    ["#/trips", "Trips", Plane],
    ["#/settings/team", "Team", Settings],
    ["/demo/checkout", "Demo checkout", Sparkles]
  ] as const;

  return (
    <aside className="border-white/10 bg-black/40 p-5 backdrop-blur-2xl lg:border-r">
      <div className="flex items-center gap-3">
        <div className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-sky-300 to-emerald-300 font-black text-slate-950 shadow-[0_18px_50px_rgba(56,189,248,.28)]">
          AT
        </div>
        <div>
          <strong className="block leading-tight text-white">Air Travel Wallet</strong>
          <span className="text-sm text-slate-400">Team booking ops</span>
        </div>
      </div>
      <nav className="mt-9 grid gap-2">
        {nav.map(([href, label, Icon]) => (
          <a
            key={href}
            href={href}
            className="flex min-h-11 items-center gap-3 rounded-2xl border border-transparent px-3 text-sm font-bold text-slate-300 transition hover:border-white/10 hover:bg-white/10 hover:text-white"
          >
            <Icon className="size-4" />
            {label}
          </a>
        ))}
      </nav>
      <div className="mt-10 rounded-3xl border border-white/10 bg-white/[0.07] p-4">
        <div className="text-xs font-black uppercase tracking-wide text-slate-400">Extension path</div>
        <code className="mt-2 block break-all rounded-2xl bg-white/10 p-3 text-xs text-slate-200">apps/extension</code>
      </div>
    </aside>
  );
}

function Topbar({ title, workspace }: { title: string; workspace: string }) {
  return (
    <header className="sticky top-0 z-20 flex min-h-24 items-center justify-between gap-4 border-b border-white/10 bg-slate-950/70 px-5 py-4 backdrop-blur-2xl md:px-8">
      <div>
        <p className="text-xs font-black uppercase tracking-wide text-slate-400">Workspace</p>
        <h1 className="mt-1 text-2xl font-black text-white md:text-3xl">{title}</h1>
      </div>
      <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2 text-sm font-bold text-slate-200">{workspace}</div>
    </header>
  );
}

function RouteView({
  route,
  data,
  selectedTraveler,
  setData,
  refresh
}: {
  route: string;
  data: Bootstrap;
  selectedTraveler: Traveler;
  setData: (data: Bootstrap) => void;
  refresh: () => Promise<void>;
}) {
  if (route === "/dashboard" || route === "/") return <Dashboard data={data} selectedTraveler={selectedTraveler} setData={setData} />;
  if (route === "/travelers") return <Travelers data={data} />;
  if (route === "/travelers/new") return <TravelerForm data={data} onSave={setData} />;
  if (/^\/travelers\/[^/]+\/edit$/.test(route)) return <TravelerForm data={data} id={route.split("/")[2]} onSave={setData} />;
  if (route.startsWith("/travelers/")) return <TravelerDetail data={data} id={route.split("/").pop() || ""} />;
  if (route === "/trips") return <Trips data={data} />;
  if (route === "/trips/new") return <TripForm data={data} onSave={setData} />;
  if (route === "/settings/team") return <Team data={data} onSave={setData} />;
  location.hash = "#/dashboard";
  refresh();
  return null;
}

function Dashboard({ data, selectedTraveler, setData }: { data: Bootstrap; selectedTraveler: Traveler; setData: (data: Bootstrap) => void }) {
  const upcoming = data.trips.filter((trip) => new Date(trip.departure_at) >= new Date());
  const missingInvoices = data.trips.filter((trip) => trip.invoice_status === "missing").length;
  const nextTrip = upcoming[0] || data.trips[0];
  const route = nextTrip ? `${nextTrip.origin_airport} to ${nextTrip.destination_airport}` : "No active route";
  const price = nextTrip?.price_amount ? `${nextTrip.price_currency || "USD"} ${Number(nextTrip.price_amount).toLocaleString()}` : "Draft";

  async function saveDefault(event: FormEvent<HTMLFormElement>) {
    const body = formData(event);
    setData(await api<Bootstrap>("/preferences", { method: "POST", body: JSON.stringify(body) }));
  }

  return (
    <div className="grid gap-6">
      <section className="relative min-h-[640px] overflow-hidden rounded-[2rem] border border-white/10 bg-[#0b312d] shadow-[0_34px_110px_rgba(0,0,0,.32)]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_25%,rgba(68,169,126,.65),transparent_18%),radial-gradient(circle_at_65%_16%,rgba(24,88,143,.72),transparent_27%),radial-gradient(circle_at_72%_78%,rgba(17,84,76,.9),transparent_30%),linear-gradient(145deg,#15463d,#0d245c_48%,#0c332e)]" />
        <div className="absolute inset-0 opacity-45 [background-image:linear-gradient(30deg,transparent_0_46%,rgba(174,222,255,.4)_47%,transparent_48%_100%),linear-gradient(140deg,transparent_0_48%,rgba(174,222,255,.36)_49%,transparent_50%_100%)] [background-size:260px_180px,320px_220px]" />
        <div className="absolute left-[9%] top-[38%] h-1 w-[32%] rotate-[-18deg] rounded-full bg-sky-200/80 shadow-[0_0_18px_rgba(186,230,253,.9)]" />
        <div className="absolute left-[37%] top-[46%] h-1 w-[42%] rotate-[29deg] rounded-full bg-sky-200/80 shadow-[0_0_18px_rgba(186,230,253,.9)]" />
        <Plane className="absolute left-[34%] top-[40%] size-9 -rotate-45 text-white drop-shadow-[0_4px_12px_rgba(0,0,0,.45)]" />
        <div className="absolute right-6 top-6 grid overflow-hidden rounded-2xl bg-white shadow-[0_14px_40px_rgba(0,0,0,.22)]">
          <button className="grid size-12 place-items-center border-b border-slate-200 text-slate-700"><MapPinned className="size-5" /></button>
          <button className="grid size-12 place-items-center text-slate-700"><Radar className="size-5" /></button>
        </div>
        <div className="absolute right-7 top-[410px] rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-lg">Cloudy 16</div>

        <div className="absolute inset-x-0 bottom-0 rounded-t-[1.3rem] border-4 border-white/45 bg-[#fbfbfc] p-5 text-slate-950 shadow-[0_-60px_90px_rgba(0,0,0,.16)] md:mx-auto md:max-w-[980px]">
          <div className="flex flex-col gap-5 lg:flex-row">
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="grid size-[52px] place-items-center rounded-full bg-gradient-to-br from-slate-200 to-slate-400 text-sm font-black">AT</div>
                  <div>
                    <h2 className="text-[22px] font-black tracking-[-0.01em] text-black">{travelerName(selectedTraveler)}</h2>
                    <p className="text-sm text-black/45">Default booking profile</p>
                  </div>
                </div>
                <a className="grid size-8 place-items-center rounded-full bg-black/5 text-sm font-black text-black/55" href={`#/travelers/${selectedTraveler.id}/edit`}>x</a>
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                <FlightyChip icon={<UsersRound />} label="Travelers" href="#/travelers" />
                <FlightyChip icon={<Settings />} label="Agent rules" href={`#/travelers/${selectedTraveler.id}/edit`} />
                <FlightyChip icon={<Plane />} label="Demo checkout" href="/demo/checkout" />
              </div>
              <div className="mt-4 flex gap-7 overflow-hidden text-sm">
                {["Now", "2026", "Trips", "Vault", "Team"].map((item, index) => (
                  <span key={item} className={cx("whitespace-nowrap rounded-xl px-4 py-2", index === 0 ? "border border-black/10 bg-black/[0.06] text-black" : "text-black/48")}>{item}</span>
                ))}
              </div>
            </div>

            <div className="grid gap-3 lg:w-[430px]">
              <FlightyPassportCard
                title="Air Travel Wallet Passport"
                subtitle="Profile · Rules · Checkout"
                stats={[
                  ["Trips", data.trips.length.toString()],
                  ["Travelers", data.travelers.length.toString()],
                  ["Invoices", missingInvoices.toString()]
                ]}
                footer={selectedTraveler.booking_rules || "No paid extras unless approved. Stop before payment."}
              />
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_.74fr]">
        <section className="rounded-[1.6rem] border border-[#434345] bg-[#18181a] p-5 text-white shadow-[0_24px_80px_rgba(0,0,0,.28)]">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-full bg-white/8">
                <Plane className="size-5 text-sky-300" />
              </div>
              <div>
                <p className="text-sm font-semibold text-[#7e7d82]">{nextTrip?.airline || "Checkout agent"} · {fmtDate(nextTrip?.departure_at)}</p>
                <h2 className="mt-0.5 text-xl font-black">{route}</h2>
              </div>
            </div>
            <a className="rounded-full bg-[#007dfe] px-4 py-2 text-sm font-bold text-white" href="/demo/checkout">Live Share</a>
          </div>
          <div className="mt-5 rounded-2xl bg-[#002714] px-5 py-4 text-[#00bb63]">
            <strong className="block text-base">Agent ready</strong>
            <span className="text-sm">Step-by-step cursor, action labels, and short reasoning are visible in the extension.</span>
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-[1fr_auto]">
            <div>
              <p className="flex items-center gap-2 text-base font-semibold text-white"><MapPinned className="size-4" /> {nextTrip?.destination_airport || "Destination"}</p>
              <p className="mt-1 text-[44px] font-semibold leading-none text-[#00b45d]">Ready</p>
              <p className="mt-2 text-sm text-white/66">Price {price} · Baggage {nextTrip?.baggage_summary || selectedTraveler.baggage_preference}</p>
            </div>
            <div className="grid content-start gap-2">
              <div className="rounded-xl bg-[#fec00c] px-4 py-2 text-center text-base font-black text-black">{nextTrip?.booking_reference || "A23"}</div>
              <p className="text-center text-sm text-white/50">PNR / Gate</p>
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-[1.6rem] border border-red-300/20 bg-[#621013] p-5 text-white shadow-[0_24px_80px_rgba(0,0,0,.24)]">
          <div className="flex justify-between">
            <div className="text-[64px] font-semibold leading-none">0</div>
            <ReceiptText className="size-5 text-white/70" />
          </div>
          <h3 className="mt-3 text-xl font-black">manual steps desired</h3>
          <p className="mt-1 text-white/50">Target UX: pick flight, start agent, approve only uncertainty or payment.</p>
          <a className="mt-6 flex items-center justify-between rounded-xl border border-red-200/20 bg-white/10 px-5 py-3 text-sm" href="#/travelers">
            Review saved profiles <span>›</span>
          </a>
        </section>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Metric icon={<CalendarDays />} title="Upcoming trips" value={upcoming.length} detail="Booked or draft trips still ahead" />
        <Metric icon={<UserRound />} title="Traveler profiles" value={data.travelers.length} detail="Reusable passenger data" />
        <Metric icon={<ReceiptText />} title="Missing invoices" value={missingInvoices} detail="Company records needing attention" tone={missingInvoices ? "warn" : "ok"} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <Panel title="Upcoming trips" action={<SecondaryLink href="#/trips/new">Add trip</SecondaryLink>}>
          <TripTable data={data} trips={upcoming.slice(0, 5)} />
        </Panel>
        <Panel title="Quick actions">
          <form className="grid gap-3" onSubmit={saveDefault}>
            <Label title="Default checkout traveler">
              <select name="selected_traveler_id" defaultValue={selectedTraveler.id}>
                {data.travelers.map((traveler) => (
                  <option key={traveler.id} value={traveler.id}>
                    {travelerName(traveler)}
                  </option>
                ))}
              </select>
            </Label>
            <PrimaryButton>Use this traveler</PrimaryButton>
          </form>
          <div className="mt-4 grid gap-3">
            <PrimaryLink href="#/travelers/new">Add traveler</PrimaryLink>
            <SecondaryLink href="/demo/checkout">Open demo checkout</SecondaryLink>
            <SecondaryLink href="#/settings/team">Invite team member</SecondaryLink>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function FlightyChip({ icon, label, href }: { icon: ReactNode; label: string; href: string }) {
  return (
    <a href={href} className="inline-flex items-center gap-2 rounded-xl border border-black/20 bg-[#eeeeee] px-4 py-2 text-[15px] text-[#313131]">
      <span className="text-lg">{icon}</span>
      {label}
    </a>
  );
}

function FlightyPassportCard({ title, subtitle, stats, footer }: { title: string; subtitle: string; stats: Array<[string, string]>; footer: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-[#170144] p-6 text-white">
      <div className="absolute -bottom-16 -left-14 size-48 rotate-[-15deg] rounded-full bg-[#4555ff]/35 blur-2xl" />
      <div className="absolute -bottom-10 right-0 size-56 rounded-full bg-[#0d90ff]/25 blur-3xl" />
      <div className="relative">
        <h3 className="text-xl font-semibold">{title}</h3>
        <p className="mt-1 text-xs text-white/45">{subtitle}</p>
        <div className="mt-6 grid grid-cols-3 gap-3">
          {stats.map(([label, value]) => (
            <div key={label}>
              <p className="text-sm text-white/45">{label}</p>
              <p className="mt-2 text-3xl font-semibold">{value}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 rounded-lg border border-[#b4beff]/45 bg-white/10 px-4 py-3 text-sm text-white/90">{footer}</div>
      </div>
    </div>
  );
}

function Travelers({ data }: { data: Bootstrap }) {
  return (
    <Panel title="Traveler profiles" action={<PrimaryLink href="#/travelers/new">Add traveler</PrimaryLink>}>
      <div className="overflow-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="border-b border-white/10 px-3 py-3">Name</th>
              <th className="border-b border-white/10 px-3 py-3">Nationality</th>
              <th className="border-b border-white/10 px-3 py-3">Passport</th>
              <th className="border-b border-white/10 px-3 py-3">Expiry</th>
              <th className="border-b border-white/10 px-3 py-3">Rules</th>
              <th className="border-b border-white/10 px-3 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.travelers.map((traveler) => (
              <tr key={traveler.id} className="text-slate-200">
                <td className="border-b border-white/10 px-3 py-4 font-bold">
                  <a className="text-sky-200" href={`#/travelers/${traveler.id}`}>
                    {travelerName(traveler)}
                  </a>
                </td>
                <td className="border-b border-white/10 px-3 py-4">{traveler.nationality}</td>
                <td className="border-b border-white/10 px-3 py-4">{traveler.document?.masked_document_number || "Not added"}</td>
                <td className="border-b border-white/10 px-3 py-4">{fmtDate(traveler.document?.expiry_date)}</td>
                <td className="max-w-md border-b border-white/10 px-3 py-4 text-slate-300">{traveler.booking_rules || traveler.baggage_preference || "Not set"}</td>
                <td className="border-b border-white/10 px-3 py-4">
                  <SecondaryLink href={`#/travelers/${traveler.id}/edit`}>Edit</SecondaryLink>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function TravelerForm({ data, id, onSave }: { data: Bootstrap; id?: string; onSave: (data: Bootstrap) => void }) {
  const traveler = id ? data.travelers.find((item) => item.id === id) : undefined;
  const isEdit = Boolean(traveler);

  async function submit(event: FormEvent<HTMLFormElement>) {
    const body = formData(event);
    const saved = await api<Bootstrap>(isEdit ? `/travelers/${traveler?.id}` : "/travelers", { method: "POST", body: JSON.stringify(body) });
    onSave(saved);
    location.hash = isEdit ? `#/travelers/${traveler?.id}` : "#/travelers";
  }

  async function remove() {
    if (!traveler || !confirm("Delete this traveler and their linked trips from this local demo?")) return;
    const saved = await api<Bootstrap>(`/travelers/${traveler.id}`, { method: "DELETE" });
    onSave(saved);
    location.hash = "#/travelers";
  }

  return (
    <Panel
      title={isEdit ? travelerName(traveler) : "New traveler"}
      eyebrow={isEdit ? "Edit traveler" : "Traveler vault"}
      action={isEdit ? <button className="rounded-full border border-red-300/30 bg-red-400/10 px-4 py-2 text-sm font-black text-red-200" type="button" onClick={remove}>Delete</button> : null}
      narrow
    >
      <form className="grid gap-4 md:grid-cols-2" onSubmit={submit}>
        <input type="hidden" name="workspace_id" value={traveler?.workspace_id || data.workspaces[0]?.id || ""} />
        <Label title="First name"><input name="first_name" defaultValue={traveler?.first_name || ""} required /></Label>
        <Label title="Middle name"><input name="middle_name" defaultValue={traveler?.middle_name || ""} /></Label>
        <Label title="Last name"><input name="last_name" defaultValue={traveler?.last_name || ""} required /></Label>
        <Label title="Date of birth"><input name="date_of_birth" type="date" defaultValue={traveler?.date_of_birth || ""} required /></Label>
        <Label title="Title / gender">
          <select name="gender" defaultValue={traveler?.gender || ""}>
            <option value="">Not set</option>
            <option value="male">Mr</option>
            <option value="female">Mrs/Ms</option>
          </select>
        </Label>
        <Label title="Nationality"><input name="nationality" defaultValue={traveler?.nationality || ""} required /></Label>
        <Label title="Email"><input name="email" type="email" defaultValue={traveler?.email || ""} required /></Label>
        <Label title="Phone"><input name="phone" defaultValue={traveler?.phone || ""} /></Label>
        <Label title="Document type">
          <select name="document_type" defaultValue={traveler?.document?.document_type || "passport"}>
            <option>passport</option>
            <option>national ID</option>
          </select>
        </Label>
        <Label title="Passport number"><input name="document_number" placeholder={traveler?.document?.masked_document_number ? `Current: ${traveler.document.masked_document_number}` : ""} required={!isEdit} /></Label>
        <Label title="Issuing country"><input name="issuing_country" defaultValue={traveler?.document?.issuing_country || traveler?.nationality || ""} /></Label>
        <Label title="Passport expiry"><input name="expiry_date" type="date" defaultValue={traveler?.document?.expiry_date || ""} required /></Label>
        <Label title="Seat preference">
          <select name="preferred_seat" defaultValue={traveler?.preferred_seat || "no preference"}>
            <option>aisle</option>
            <option>window</option>
            <option>no preference</option>
          </select>
        </Label>
        <Label title="Baggage preference">
          <select name="baggage_preference" defaultValue={traveler?.baggage_preference || "personal item"}>
            <option>personal item</option>
            <option>cabin bag</option>
            <option>checked bag</option>
          </select>
        </Label>
        <Label title="Cabin">
          <select name="default_cabin" defaultValue={traveler?.default_cabin || "economy"}>
            <option>economy</option>
            <option>business</option>
          </select>
        </Label>
        <Label title="Invoice company"><input name="invoice_company" defaultValue={traveler?.invoice_company || ""} /></Label>
        <Label title="Billing tax ID"><input name="billing_tax_id" defaultValue={traveler?.billing_tax_id || ""} /></Label>
        <Label title="Billing address"><input name="billing_address" defaultValue={traveler?.billing_address || ""} /></Label>
        <Label title="Billing email"><input name="billing_email" type="email" defaultValue={traveler?.billing_email || ""} /></Label>
        <Label title="Payment preference">
          <select name="payment_preference" defaultValue={traveler?.payment_preference || "browser saved card"}>
            <option>browser saved card</option>
            <option>Apple Pay / Google Pay</option>
            <option>company virtual card</option>
            <option>manual payment</option>
          </select>
        </Label>
        <Label title="Booking rules / agent context" wide>
          <textarea
            name="booking_rules"
            defaultValue={traveler?.booking_rules || ""}
            placeholder="Example: No paid seats, no insurance, no bundles, no SMS updates, personal item only, stop before payment."
          />
        </Label>
        <div className="md:col-span-2">
          <PrimaryButton>{isEdit ? "Save traveler" : "Create traveler"}</PrimaryButton>
        </div>
      </form>
    </Panel>
  );
}

function TravelerDetail({ data, id }: { data: Bootstrap; id: string }) {
  const traveler = data.travelers.find((item) => item.id === id) || data.travelers[0];
  const rows = [
    ["Nationality", traveler.nationality],
    ["Title / gender", traveler.gender || "Not set"],
    ["Date of birth", fmtDate(traveler.date_of_birth)],
    ["Passport", traveler.document?.masked_document_number || "Not added"],
    ["Passport expiry", fmtDate(traveler.document?.expiry_date)],
    ["Email", traveler.email],
    ["Phone", traveler.phone],
    ["Default baggage", traveler.baggage_preference],
    ["Booking rules", traveler.booking_rules || "Not set"],
    ["Invoice company", traveler.invoice_company || "Not set"],
    ["Billing email", traveler.billing_email || "Not set"],
    ["Payment preference", traveler.payment_preference || "browser saved card"]
  ];
  return (
    <Panel title={travelerName(traveler)} eyebrow="Traveler profile" action={<PrimaryLink href={`#/travelers/${traveler.id}/edit`}>Edit traveler</PrimaryLink>} narrow>
      <dl className="grid gap-3">
        {rows.map(([term, value]) => (
          <div key={term} className="grid gap-2 border-b border-white/10 pb-3 md:grid-cols-[170px_1fr]">
            <dt className="font-bold text-slate-400">{term}</dt>
            <dd className="text-slate-200">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-5 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
        Sensitive document values are stored encrypted by the local API and masked by default in UI responses. Card numbers are not stored.
      </p>
    </Panel>
  );
}

function Trips({ data }: { data: Bootstrap }) {
  return (
    <Panel title="Trips" action={<PrimaryLink href="#/trips/new">Add trip</PrimaryLink>}>
      <TripTable data={data} trips={data.trips} />
    </Panel>
  );
}

function TripTable({ data, trips }: { data: Bootstrap; trips: Trip[] }) {
  if (!trips.length) return <p className="text-slate-400">No trips yet.</p>;
  return (
    <div className="overflow-auto">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-slate-400">
          <tr>
            {["Traveler", "Route", "Date", "Airline", "PNR", "Invoice", "Warnings"].map((head) => (
              <th key={head} className="border-b border-white/10 px-3 py-3">{head}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {trips.map((trip) => {
            const traveler = data.travelers.find((item) => item.id === trip.traveler_profile_id) || data.travelers[0];
            return (
              <tr key={trip.id} className="text-slate-200">
                <td className="border-b border-white/10 px-3 py-4">{travelerName(traveler)}</td>
                <td className="border-b border-white/10 px-3 py-4">{trip.origin_airport} to {trip.destination_airport}</td>
                <td className="border-b border-white/10 px-3 py-4">{fmtDate(trip.departure_at)}</td>
                <td className="border-b border-white/10 px-3 py-4">{trip.airline}</td>
                <td className="border-b border-white/10 px-3 py-4">{trip.booking_reference || "Not set"}</td>
                <td className="border-b border-white/10 px-3 py-4"><Status value={trip.invoice_status} /></td>
                <td className="border-b border-white/10 px-3 py-4">{(trip.warnings || []).join("; ") || "No warnings"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TripForm({ data, onSave }: { data: Bootstrap; onSave: (data: Bootstrap) => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    const body = formData(event);
    const saved = await api<Bootstrap>("/trips", { method: "POST", body: JSON.stringify(body) });
    onSave(saved);
    location.hash = "#/trips";
  }

  return (
    <Panel title="Manual trip" narrow>
      <form className="grid gap-4 md:grid-cols-2" onSubmit={submit}>
        <input type="hidden" name="workspace_id" value={data.workspaces[0]?.id || ""} />
        <Label title="Traveler">
          <select name="traveler_profile_id">
            {data.travelers.map((traveler) => <option key={traveler.id} value={traveler.id}>{travelerName(traveler)}</option>)}
          </select>
        </Label>
        <Label title="Airline"><input name="airline" required /></Label>
        <Label title="Seller"><select name="seller"><option>airline direct</option><option>known OTA</option><option>unknown OTA</option></select></Label>
        <Label title="Origin airport"><input name="origin_airport" required /></Label>
        <Label title="Destination airport"><input name="destination_airport" required /></Label>
        <Label title="Departure"><input name="departure_at" type="datetime-local" required /></Label>
        <Label title="Return"><input name="return_at" type="datetime-local" /></Label>
        <Label title="Booking reference"><input name="booking_reference" /></Label>
        <Label title="Price"><input name="price_amount" type="number" min="0" step="0.01" /></Label>
        <Label title="Currency"><input name="price_currency" defaultValue="USD" /></Label>
        <Label title="Baggage"><input name="baggage_summary" /></Label>
        <Label title="Invoice"><select name="invoice_status"><option>missing</option><option>received</option><option>not_required</option></select></Label>
        <Label title="Notes" wide><textarea name="notes" /></Label>
        <div className="md:col-span-2"><PrimaryButton>Create trip</PrimaryButton></div>
      </form>
    </Panel>
  );
}

function Team({ data, onSave }: { data: Bootstrap; onSave: (data: Bootstrap) => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    const body = formData(event);
    const saved = await api<Bootstrap>("/invites", { method: "POST", body: JSON.stringify(body) });
    onSave(saved);
  }

  return (
    <Panel title="Team settings" narrow>
      <form className="grid gap-3 md:grid-cols-[1fr_150px_auto]" onSubmit={submit}>
        <input type="hidden" name="workspace_id" value={data.workspaces[0]?.id || ""} />
        <input name="email" type="email" placeholder="teammate@example.com" required />
        <select name="role"><option>member</option><option>admin</option></select>
        <PrimaryButton>Invite</PrimaryButton>
      </form>
      <h3 className="mt-7 text-lg font-black text-white">Members</h3>
      <div className="mt-3 grid gap-2">
        {data.members.map((member) => <Row key={member.email} left={member.email} right={member.role} />)}
      </div>
      <h3 className="mt-7 text-lg font-black text-white">Pending invites</h3>
      <div className="mt-3 grid gap-2">
        {data.invites.length ? data.invites.map((invite) => <Row key={invite.email} left={invite.email} right={invite.role} />) : <p className="text-slate-400">No invites sent.</p>}
      </div>
    </Panel>
  );
}

function Metric({ icon, title, value, detail, tone }: { icon: ReactNode; title: string; value: number; detail: string; tone?: "ok" | "warn" }) {
  return (
    <article className="rounded-[1.6rem] border border-white/10 bg-white/[0.07] p-5 shadow-[0_24px_80px_rgba(0,0,0,.24)] backdrop-blur-2xl">
      <div className={cx("mb-4 grid size-11 place-items-center rounded-2xl", tone === "warn" ? "bg-orange-400/15 text-orange-200" : tone === "ok" ? "bg-emerald-300/15 text-emerald-200" : "bg-sky-300/15 text-sky-200")}>{icon}</div>
      <span className="text-sm font-bold text-slate-400">{title}</span>
      <strong className="mt-1 block text-4xl font-black text-white">{value}</strong>
      <p className="mt-1 text-sm text-slate-400">{detail}</p>
    </article>
  );
}

function Panel({ title, eyebrow, action, children, narrow }: { title: string; eyebrow?: string; action?: ReactNode; children: ReactNode; narrow?: boolean }) {
  return (
    <section className={cx("rounded-[1.6rem] border border-white/10 bg-white/[0.07] p-5 shadow-[0_24px_80px_rgba(0,0,0,.24)] backdrop-blur-2xl", narrow && "max-w-4xl")}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          {eyebrow ? <p className="text-xs font-black uppercase tracking-wide text-slate-400">{eyebrow}</p> : null}
          <h2 className="text-2xl font-black text-white">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Label({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={cx("grid gap-2 text-sm font-bold text-slate-400", wide && "md:col-span-2")}>
      {title}
      {children}
    </label>
  );
}

function PrimaryButton({ children }: { children: ReactNode }) {
  return <button className="min-h-11 rounded-full bg-gradient-to-br from-sky-300 to-emerald-300 px-5 py-2 text-sm font-black text-slate-950 shadow-[0_16px_34px_rgba(56,189,248,.2)]" type="submit">{children}</button>;
}

function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="inline-flex min-h-11 items-center justify-center rounded-full bg-gradient-to-br from-sky-300 to-emerald-300 px-5 py-2 text-sm font-black text-slate-950 shadow-[0_16px_34px_rgba(56,189,248,.2)]" href={href}>{children}</a>;
}

function SecondaryLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/15 bg-white/10 px-5 py-2 text-sm font-black text-slate-100 transition hover:bg-white/15" href={href}>{children}</a>;
}

function Status({ value }: { value: string }) {
  const ok = value === "received";
  return <span className={cx("inline-flex rounded-full border px-3 py-1 text-xs font-black", ok ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-100" : "border-red-300/30 bg-red-300/10 text-red-100")}>{value}</span>;
}

function Row({ left, right }: { left: string; right: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm">
      <span className="font-bold text-slate-200">{left}</span>
      <span className="text-slate-400">{right}</span>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-950 text-slate-50">
      <div className="grid justify-items-center gap-4">
        <Radar className="size-12 animate-pulse text-sky-300" />
        <p className="text-sm font-bold text-slate-300">Loading Air Travel Wallet</p>
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-50">
      <div className="max-w-lg rounded-3xl border border-red-300/30 bg-red-300/10 p-6">
        <CircleAlert className="mb-4 size-8 text-red-200" />
        <h1 className="text-2xl font-black">Could not load app</h1>
        <p className="mt-2 text-red-100">{message}</p>
      </div>
    </div>
  );
}

function pageTitle(route: string) {
  if (route === "/dashboard" || route === "/") return "Dashboard";
  if (route === "/travelers") return "Travelers";
  if (route === "/travelers/new") return "New traveler";
  if (/^\/travelers\/[^/]+\/edit$/.test(route)) return "Edit traveler";
  if (route.startsWith("/travelers/")) return "Traveler detail";
  if (route === "/trips") return "Trips";
  if (route === "/trips/new") return "New trip";
  if (route === "/settings/team") return "Team settings";
  return "Dashboard";
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
