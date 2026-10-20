import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { startStartupMotion } from './startupMotion'
import type { StartupMotion } from './startupMotion'

function StartupIntro({ ready, contentRef, onComplete }: {
  ready: boolean
  contentRef: RefObject<HTMLDivElement | null>
  onComplete: () => void
}) {
  const host = useRef<HTMLElement>(null)
  const controller = useRef<StartupMotion | null>(null)
  useLayoutEffect(() => {
    if (!host.current || !contentRef.current) { onComplete(); return }
    const motion = startStartupMotion(host.current, contentRef.current, onComplete)
    controller.current = motion
    return () => { controller.current = null; motion.dispose() }
  }, [contentRef, onComplete])
  useEffect(() => { if (ready) controller.current?.ready() }, [ready])
  return <section ref={host} className="startup-intro" role="dialog" aria-modal="true" aria-label="Stringmoon 正在启动" data-phase="entering">
    <div className="startup-backdrop" aria-hidden="true" />
    <div className="startup-scene" aria-hidden="true">
      <div className="startup-atmosphere" /><div className="startup-halo" />
      <div className="startup-seed" /><div className="startup-string" />
      <svg className="startup-wave" viewBox="0 0 500 28"><path d="M0 14 C110 14 166 14 203 14 S236 -2 250 14 S266 30 297 14 S390 14 500 14" /></svg>
      <svg className="startup-orbit" viewBox="0 0 580 350"><ellipse cx="290" cy="175" rx="285" ry="82" /></svg>
      {[[405,218],[817,177],[893,381],[368,437],[822,465],[482,130],[930,265]].map(([left, top], i) => <span key={i} className="startup-star" style={{ left, top }} />)}
      <div className="startup-hero">
        <div className="startup-vinyl" />
        <svg className="startup-ring" viewBox="0 0 328 328"><circle className="startup-ring-track" cx="164" cy="164" r="160" /><circle className="startup-ring-lit" cx="164" cy="164" r="160" /></svg>
        <svg className="startup-moon" viewBox="0 0 1024 1024">
          <defs><linearGradient id="startup-moon-gradient" gradientUnits="userSpaceOnUse" x1="0" y1="30" x2="0" y2="870"><stop className="startup-stop-yellow" /><stop offset=".23" className="startup-stop-orange" /><stop offset=".48" className="startup-stop-pink" /><stop offset=".72" className="startup-stop-magenta" /><stop offset="1" className="startup-stop-violet" /></linearGradient><clipPath id="startup-moon-disc"><circle cx="512" cy="450" r="420" /></clipPath></defs>
          <g clipPath="url(#startup-moon-disc)" fill="url(#startup-moon-gradient)">{[[0,334],[343,60],[420,60],[505,56],[593,55],[687,55],[784,60],[890,90]].map(([y,height], i) => <rect key={i} className="startup-moon-band" x="0" y={y} width="1024" height={height} />)}</g>
        </svg>
        <svg className="startup-girl" viewBox="0 0 1024 1024">
          <path className="startup-ink" d="M154 826C101 796 139 689 194 625C166 600 154 570 164 528C174 480 228 444 282 397L394 265C451 183 536 137 624 139C746 133 817 189 831 280L834 408C836 464 804 492 790 525C802 562 791 599 766 625L747 653C771 706 812 755 839 828L901 1024H134C104 926 127 861 154 826Z" />
          <path className="startup-purple" d="M342 375C314 451 249 525 204 563C184 527 210 482 247 454ZM326 551C263 626 223 675 217 724C195 671 230 604 326 551ZM191 668C155 748 170 791 218 829C119 816 132 747 191 668ZM765 529C787 571 776 614 728 642C756 612 758 569 765 529Z" />
          <path className="startup-white" d="M693 286C670 343 651 363 632 365L663 328C643 364 619 382 597 383L571 411C560 445 567 476 574 481C548 455 545 431 546 393L517 410C504 404 499 399 488 407C492 423 507 438 515 441C506 480 498 548 470 591C512 611 546 636 572 665L632 664C630 630 623 616 610 607L592 601C588 578 590 555 600 534C602 526 609 530 616 533L649 550Q663 556 673 545L702 510Q720 484 730 460Q740 453 733 448L727 433Q722 418 728 404C750 369 758 338 754 316C749 344 742 363 736 384L716 381L688 369L696 343L681 373L665 372C678 347 686 320 693 286Z" />
          <path className="startup-white" d="M516 350C485 331 458 355 470 401C486 386 499 370 516 350ZM351 630C387 612 421 582 445 594C513 615 573 673 616 738C525 700 428 638 351 630ZM615 606C644 635 650 676 650 739C683 713 715 696 717 646C680 639 646 623 615 606Z" />
          <path className="startup-collar" d="M267 773C280 704 288 673 321 655C374 624 486 690 625 764C694 734 736 710 737 659" />
          <path className="startup-purple" d="M474 716C530 741 566 754 626 774L625 785C569 792 516 774 474 716ZM718 723C706 757 684 773 651 777L648 765ZM627 778Q647 767 664 782C659 825 692 842 724 880L763 928C698 908 672 877 657 845C661 890 634 929 596 948C578 899 581 858 602 829L626 801Z" />
        </svg>
      </div>
      <div className="startup-brand"><div className="startup-word">{[...'Stringmoon'].map((letter,i) => <span key={i}>{letter}</span>)}</div><p className="startup-sub">月 下 聆 听</p></div>
      <div className="startup-signature">A SPACE BETWEEN NOTES</div>
    </div>
    <p className="startup-waiting" role="status">正在准备音乐空间…</p>
    <button type="button" className="startup-skip" onClick={() => controller.current?.skip()} aria-label="跳过启动动画">跳过 <span aria-hidden="true">↗</span></button>
  </section>
}

// Scan and transport telemetry in App must not redraw the finite identity scene.
export default memo(StartupIntro)
