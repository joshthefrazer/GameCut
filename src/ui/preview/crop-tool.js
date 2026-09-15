import { bus } from '../../core/events.js';
import { openCropStudio } from './crop-studio.js';

/**
 * The Crop button.
 *
 * All this does now is decide *what* is being cropped and hand a frozen frame
 * of it to the crop studio, which owns the actual work. It used to draw the
 * rectangle itself, directly on the preview — at whatever size the preview
 * happened to be, which on a normal layout is a few hundred pixels wide. You
 * cannot trace the edge of a killfeed at that size, and no amount of tidying
 * the code was going to change that.
 *
 * The public shape is unchanged (`arm`, `disarm`, `toggle`, `isArmed`) so the
 * toolbar button, the keyboard shortcut and the clip's right-click menu all
 * keep working without knowing any of this happened.
 */
export function initCropTool({ overlay, store, comp, cmds, playback, onDone }) {
  let studio = null;

  const isArmed = () => !!studio;

  const hasPicture = (c) => !!c && (c.type === 'video' || c.type === 'image');

  /**
   * Which clip the crop is for.
   *
   * What you have selected, when that is a picture — because if you went to the
   * trouble of selecting something, that is the thing you mean. Otherwise the
   * topmost picture under the playhead, so pressing C with nothing selected
   * still does the obvious thing rather than complaining.
   */
  function target(t) {
    const sel = store.selectedClips?.[0]?.clip;
    if (hasPicture(sel)) return sel;
    const stack = comp.activeClips(t).filter(({ clip }) => hasPicture(clip));
    return stack.length ? stack[stack.length - 1].clip : null;
  }

  function arm() {
    if (studio) return;
    playback.pause();

    const t = store.rt.playhead;
    const clip = target(t);
    if (!clip) {
      bus.emit('toast', {
        msg: 'Move the playhead over some footage first — there is no picture here to crop.',
        kind: 'err',
      });
      return;
    }

    /*
     * peek() first: the preview has already put this element on the right
     * frame, and frameFor() would seek it again for no reason.
     *
     * But `peek` hands back an element at HAVE_METADATA — it has a width and a
     * height and no picture yet — and drawing one of those returns quietly
     * without drawing and without throwing. The result was a crop room opened
     * full-screen over nothing at all, inviting you to paint a mask on a blank
     * rectangle, with no error anywhere. So the readyState is checked here
     * rather than trusted.
     */
    const ready = (el) => !!el && (el.readyState === undefined || el.readyState >= 2);
    let source = comp.pool.peek(clip);
    if (!ready(source)) source = comp.pool.frameFor(clip, t, false);
    if (!ready(source)) {
      bus.emit('toast', {
        msg: 'That clip has not finished loading yet — give it a second and press C again.',
        kind: 'err',
      });
      return;
    }

    studio = openCropStudio({
      clip, source, store, cmds, comp,
      onApply: () => { studio = null; onDone?.(false); },
    });
    if (!studio) return;
    onDone?.(true);
  }

  function disarm() {
    if (!studio) return;
    const s = studio;
    studio = null;
    // `close()` runs the studio's own onApply, which already reports the tool
    // as off. Calling onDone here as well fired the same lifecycle callback
    // twice for one closing.
    s.close();
  }

  const toggle = () => (studio ? disarm() : arm());

  void overlay;
  return { arm, disarm, toggle, isArmed };
}
