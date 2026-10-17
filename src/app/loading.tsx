// Shown the moment a killboard link is followed, while the page's queries run, and prefetched with
// each link so navigation answers at once.
export default function Loading() {
  return (
    <main className="kb-shell kb-notice" aria-busy="true">
      <div className="kb-live kb-console">Receiving</div>
    </main>
  );
}
