import { createContext, useContext, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const HandleCtx = createContext<{ attributes: DraggableAttributes; listeners: DraggableSyntheticListeners } | null>(null);

/**
 * Grip shown in a block's header. Only the grip drags, so charts keep their own taps and the page
 * still scrolls on phones (touch needs a short press before dragging).
 */
export function DragHandle({ label }: { label: string }) {
  const { t } = useTranslation();
  const ctx = useContext(HandleCtx);
  if (!ctx) return null;
  return (
    <button
      type="button"
      className="shrink-0 cursor-grab touch-none rounded px-1.5 py-0.5 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:cursor-grabbing"
      aria-label={t('reports.dragBlock', { name: label })}
      title={t('reports.dragBlock', { name: label })}
      {...ctx.attributes}
      {...ctx.listeners}
    >
      ⠿
    </button>
  );
}

function Item<K extends string>({ id, wide, children }: { id: K; wide: boolean; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`${wide ? 'lg:col-span-2' : ''} ${isDragging ? 'relative z-20 opacity-80 shadow-xl' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <HandleCtx.Provider value={{ attributes, listeners }}>{children}</HandleCtx.Provider>
    </div>
  );
}

/** Two-column grid of blocks that can be dragged into a new order (mouse, touch and keyboard). */
export function SortableWidgets<K extends string>({
  order,
  wide,
  render,
  onReorder,
}: {
  order: K[];
  wide: ReadonlySet<K>;
  render: (k: K) => ReactNode;
  onReorder: (next: K[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Blocks with nothing to show (e.g. locations with a single location) are skipped.
  const items = order.map((k) => ({ k, node: render(k) })).filter((x) => x.node != null);
  const ids = items.map((x) => x.k);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = order.indexOf(active.id as K);
    const to = order.indexOf(over.id as K);
    if (from >= 0 && to >= 0) onReorder(arrayMove(order, from, to));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <div className="grid gap-6 lg:grid-cols-2">
          {items.map(({ k, node }) => (
            <Item key={k} id={k} wide={wide.has(k)}>
              {node}
            </Item>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
