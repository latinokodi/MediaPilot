import { useDiscoverStore } from '../store/discoverTabs'

export function DiscoverThumbnails({
  items,
  onClick,
}: {
  items: any[]
  onClick: (item: any) => void
}) {
  return (
    <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8 gap-1.5">
      {items.map((item) => (
        <div
          key={item.id}
          className="glass-panel overflow-hidden cursor-pointer transition-all hover:border-accent hover:scale-[1.02] group"
          onClick={() => onClick(item)}
        >
          <div className="aspect-[2/3] bg-bg-deep relative overflow-hidden">
            {item.poster ? (
              <img
                src={item.poster}
                alt={item.title}
                className="w-full h-full object-cover group-hover:opacity-80 transition-opacity"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-text-muted text-2xl">
                ?
              </div>
            )}
            <div className="absolute top-1 right-1 bg-accent text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
              {item.rating}
            </div>
          </div>
          <div className="p-1.5">
            <div className="font-bold text-text-heading text-[11px] leading-tight truncate" title={item.title}>
              {item.title}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
