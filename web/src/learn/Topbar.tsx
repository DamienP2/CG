import { CircleHelp, LogOut } from 'lucide-react';
import { navigate } from '../router';
import { t, useLang } from '../i18n';
import { lessonById, quitLesson, useLearn } from './store';

/** « ? »: the lessons, examples and tips. */
export function HelpButton({ on }: { on?: boolean }) {
  useLang((s) => s.lang);
  return (
    <button className={`learn-help ${on ? 'on' : ''}`} title={t('Learn: lessons, examples, tips')} aria-label={t('Learn')} onClick={() => navigate('/learn')}>
      <CircleHelp size={17} />
    </button>
  );
}

/** A lesson going on: « Training » (or « Lesson » on a real page) and its way out. */
export function TrainingBar() {
  useLang((s) => s.lang);
  const active = useLearn((s) => s.active);
  const lesson = active ? lessonById(active.id) : undefined;
  if (!lesson) return null;
  const training = lesson.setup.kind !== 'page';
  return (
    <span className="learn-bar-top">
      <span className="learn-pill" title={training ? t('Training: nothing is saved, nothing goes on air') : undefined}>
        {training ? t('Training') : t('Lesson')}
      </span>
      <button className="btn small learn-quit" title={t('Leave the lesson')} onClick={() => void quitLesson()}>
        <LogOut size={13} /> {t('Quit')}
      </button>
    </span>
  );
}
