import { $ } from "../shared/dom.js";
import * as CellAccess from '../features/data/cell-access.js';
import { readText, writeText } from '../core/storage.js';
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const MOTION_STORAGE_KEY = 'code-lab:motion:v1';
let feedbackAnimations = [];
let lastFeedbackKey = '';
let completedFeedbackRun = null;
export function createMotion({
  state
}) {
  function cancelFeedback() {
    feedbackAnimations.forEach(animation => animation.cancel());
    feedbackAnimations = [];
  }
  function setupMotion() {
    try {
      const saved = readText(MOTION_STORAGE_KEY);
      if (['standard', 'reduced', 'off'].includes(saved)) $('motion').value = saved;
    } catch {/* 存储不可用时使用当前页设置。 */}
    const apply = () => {
      const selected = $('motion').value;
      document.documentElement.dataset.motion = selected === 'standard' && motionQuery.matches ? 'reduced' : selected;
      cancelFeedback();
    };
    $('motion').addEventListener('change', () => {
      try {
        writeText(MOTION_STORAGE_KEY, $('motion').value);
      } catch {/* 设置仍即时生效。 */}
      apply();
    });
    motionQuery.addEventListener('change', apply);
    apply();
  }
  function animateFeedback(element, frames, duration = 200) {
    if (!element || !element.getClientRects().length) return;
    feedbackAnimations.push(element.animate(frames, {
      duration,
      easing: 'cubic-bezier(.2,.7,.3,1)'
    }));
  }
  function pointerVisible(cell) {
    const rect = cell.getBoundingClientRect();
    // 同时尊重数组内滚动与数组面板的纵向裁剪。
    for (const container of [cell.closest('.structure-scroll'), cell.closest('.data-body')]) {
      const bounds = container.getBoundingClientRect();
      if (rect.left < bounds.left || rect.right > bounds.right || rect.top - 27 < bounds.top || rect.bottom > bounds.bottom) return false;
    }
    return true;
  }
  function showStepFeedback(oldPointers) {
    const key = state.snapshot ? `${state.snapshot.runId}:${state.snapshot.step}` : '';
    if (!key || key === lastFeedbackKey) return;
    lastFeedbackKey = key;
    const completed = state.snapshot.status === 'completed' && completedFeedbackRun !== state.snapshot.runId;
    if (completed) completedFeedbackRun = state.snapshot.runId;
    if (document.documentElement.dataset.motion !== 'standard' || state.playing && Number($('speed').value) <= 300) return;
    animateFeedback($('edit-highlight').querySelector('.executed .line-text'), [{
      opacity: .45
    }, {
      opacity: 1
    }], 160);
    for (const value of document.querySelectorAll('.changed .current-value, .element.changed .element-value')) {
      if (value.closest('.access-write')) continue;
      animateFeedback(value, [{
        transform: 'scale(1)',
        opacity: .6
      }, {
        transform: 'scale(1.08)',
        opacity: 1,
        offset: .45
      }, {
        transform: 'scale(1)',
        opacity: 1
      }], 220);
    }
    CellAccess.animate(animateFeedback);
    for (const mark of document.querySelectorAll('.io-changed')) animateFeedback(mark, [{
      opacity: .4
    }, {
      opacity: 1
    }], 180);
    for (const cell of document.querySelectorAll('.element.indexed')) {
      const label = (cell.dataset.pointerLabel || '').replace(/-?\d+/g, '#');
      const old = oldPointers.get(`${cell.dataset.variableId}:${label}`);
      // 只有同一变量的单个指针才做位移；多格行列强调保持静止，避免暗示一次真实内存访问。
      const card = cell.closest('.data-card');
      if (!old || !pointerVisible(cell) || card.querySelectorAll('.indexed').length !== 1 || old.coordinates === cell.dataset.coordinates) continue;
      const rect = cell.getBoundingClientRect();
      const dx = old.left - rect.left,
        dy = old.top - rect.top;
      if (Math.abs(dx) > card.clientWidth || Math.abs(dy) > card.clientHeight) continue;
      // 指针通过独立浮层移动，当前值和单元格位置始终准确。
      const pointer = document.createElement('span');
      pointer.className = 'moving-pointer';
      pointer.textContent = '↓ ' + cell.dataset.pointerLabel;
      pointer.style.left = rect.left + 'px';
      pointer.style.top = rect.top - 27 + 'px';
      pointer.setAttribute('aria-hidden', 'true');
      document.body.append(pointer);
      const animation = pointer.animate([{
        transform: `translate(${dx}px,${dy}px)`
      }, {
        transform: 'translate(0,0)'
      }], {
        duration: 200,
        easing: 'cubic-bezier(.2,.7,.3,1)'
      });
      cell.classList.add('pointer-moving');
      const clean = () => {
        pointer.remove();
        cell.classList.remove('pointer-moving');
      };
      animation.onfinish = clean;
      animation.oncancel = clean;
      feedbackAnimations.push(animation);
    }
    if (completed) animateFeedback($('status'), [{
      transform: 'scale(.9)',
      opacity: .5
    }, {
      transform: 'scale(1.06)',
      offset: .6
    }, {
      transform: 'scale(1)',
      opacity: 1
    }], 360);
  }
  return {
    cancelFeedback,
    setupMotion,
    pointerVisible,
    showStepFeedback
  };
}
