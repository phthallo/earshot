import { copy } from '../copy';

type Props = {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onRotateLeft?: () => void;
  onRotateRight?: () => void;
};

export function MapButtons({ onZoomIn, onZoomOut, onReset, onRotateLeft, onRotateRight }: Props) {
  return (
    <span className="map-buttons" role="group" aria-label={copy.scene.viewControls}>
      {onRotateLeft && (
        <button type="button" onClick={onRotateLeft} aria-label={copy.scene.rotateLeft} title={copy.scene.rotateLeft}>
          ↶
        </button>
      )}
      {onRotateRight && (
        <button type="button" onClick={onRotateRight} aria-label={copy.scene.rotateRight} title={copy.scene.rotateRight}>
          ↷
        </button>
      )}
      <button type="button" onClick={onZoomOut} aria-label={copy.scene.zoomOut} title={copy.scene.zoomOut}>
        −
      </button>
      <button type="button" onClick={onZoomIn} aria-label={copy.scene.zoomIn} title={copy.scene.zoomIn}>
        +
      </button>
      <button type="button" onClick={onReset} title={copy.scene.fit}>
        {copy.scene.fit}
      </button>
    </span>
  );
}
