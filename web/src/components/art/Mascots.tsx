import type { ReactNode, SVGProps } from 'react';

/**
 * "Voxies" — VoxDrop's ORIGINAL mascot family (no third-party characters).
 * One shared construction (chunky egg body, thick ink outline, big eyes, soft
 * top highlight) keeps every illustration in the same art direction. Pure SVG:
 * no network requests, crisp at any size, and code-split with the pages that use them.
 */
const INK = '#0B0D12';
const SW = 3.5;

type Ears = 'round' | 'pointy' | 'horns' | 'none';
interface CritterProps {
  body: string;
  shade: string;
  belly: string;
  ears?: Ears;
  earInner?: string;
  mood?: 'smile' | 'grin' | 'focus';
  mask?: boolean;
  behind?: ReactNode;
  children?: ReactNode;
}

function Critter({ body, shade, belly, ears = 'round', earInner = '#FF8FA8', mood = 'smile', mask, behind, children }: CritterProps) {
  return (
    <g strokeLinejoin="round" strokeLinecap="round">
      <ellipse cx="80" cy="151" rx="46" ry="6" fill="#000" opacity=".35" />
      {behind}
      {ears === 'round' && (
        <g stroke={INK} strokeWidth={SW}>
          <circle cx="46" cy="46" r="15" fill={body} />
          <circle cx="114" cy="46" r="15" fill={body} />
          <circle cx="46" cy="46" r="7" fill={earInner} stroke="none" />
          <circle cx="114" cy="46" r="7" fill={earInner} stroke="none" />
        </g>
      )}
      {ears === 'pointy' && (
        <g stroke={INK} strokeWidth={SW}>
          <path d="M40 64 L44 20 L74 44 Z" fill={body} />
          <path d="M120 64 L116 20 L86 44 Z" fill={body} />
          <path d="M47 50 L49 32 L62 43 Z" fill={earInner} stroke="none" />
          <path d="M113 50 L111 32 L98 43 Z" fill={earInner} stroke="none" />
        </g>
      )}
      {ears === 'horns' && (
        <g stroke={INK} strokeWidth={SW} fill="#FF9F43">
          <path d="M56 44 Q46 22 58 10 Q62 28 72 38 Z" />
          <path d="M104 44 Q114 22 102 10 Q98 28 88 38 Z" />
        </g>
      )}
      {/* feet */}
      <ellipse cx="60" cy="143" rx="15" ry="8" fill={shade} stroke={INK} strokeWidth={SW} />
      <ellipse cx="100" cy="143" rx="15" ry="8" fill={shade} stroke={INK} strokeWidth={SW} />
      {/* body */}
      <path d="M80 34 C116 34 132 66 132 98 C132 128 110 146 80 146 C50 146 28 128 28 98 C28 66 44 34 80 34 Z" fill={body} stroke={INK} strokeWidth={SW} />
      <path d="M36 110 C40 134 58 144 80 144 C102 144 120 134 124 110 C114 128 98 134 80 134 C62 134 46 128 36 110 Z" fill={shade} opacity=".55" />
      <ellipse cx="80" cy="114" rx="29" ry="24" fill={belly} />
      <ellipse cx="60" cy="56" rx="15" ry="8" fill="#fff" opacity=".28" transform="rotate(-25 60 56)" />
      {mask && <path d="M42 84 Q52 64 80 75 Q108 64 118 84 Q108 98 80 89 Q52 98 42 84 Z" fill="#2B2F3A" />}
      {/* eyes */}
      <g>
        <ellipse cx="65" cy="82" rx="10" ry="12" fill="#fff" stroke={INK} strokeWidth="2.5" />
        <ellipse cx="95" cy="82" rx="10" ry="12" fill="#fff" stroke={INK} strokeWidth="2.5" />
        <circle cx={mood === 'focus' ? 66 : 67} cy={mood === 'focus' ? 83 : 84} r="6" fill={INK} />
        <circle cx={mood === 'focus' ? 94 : 97} cy={mood === 'focus' ? 83 : 84} r="6" fill={INK} />
        <circle cx="69" cy="81" r="2" fill="#fff" />
        <circle cx="99" cy="81" r="2" fill="#fff" />
        {mood === 'focus' && <path d="M54 67 L74 72 M106 67 L86 72" stroke={INK} strokeWidth="4" />}
      </g>
      <ellipse cx="50" cy="100" rx="7" ry="4" fill="#FF6B8A" opacity=".55" />
      <ellipse cx="110" cy="100" rx="7" ry="4" fill="#FF6B8A" opacity=".55" />
      {mood === 'smile' && <path d="M71 101 Q80 110 89 101" fill="none" stroke={INK} strokeWidth="3" />}
      {mood === 'focus' && <path d="M72 104 L88 104" fill="none" stroke={INK} strokeWidth="3" />}
      {mood === 'grin' && (
        <g>
          <path d="M66 98 Q80 120 94 98 Z" fill="#3A0D16" stroke={INK} strokeWidth="2.5" />
          <path d="M73 108 Q80 104 87 108 Q84 114 80 114 Q76 114 73 108 Z" fill="#FF6B8A" />
          <path d="M70 99 H90 V102 H70 Z" fill="#fff" />
        </g>
      )}
      {children}
    </g>
  );
}

type ArtProps = SVGProps<SVGSVGElement> & { title?: string };
function Svg({ title, children, viewBox = '0 0 160 160', ...rest }: ArtProps & { children: ReactNode }) {
  return (
    <svg viewBox={viewBox} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title} {...rest}>
      {children}
    </svg>
  );
}

const arm = (cx: number, cy: number, rot: number, fill: string) => <ellipse cx={cx} cy={cy} rx="9" ry="14" fill={fill} stroke={INK} strokeWidth={SW} transform={`rotate(${rot} ${cx} ${cy})`} />;

/** Voice messages — a small dragon belting into a microphone. */
export function DragonMic(p: ArtProps) {
  return (
    <Svg {...p}>
      <Critter
        body="#5BC46A"
        shade="#3E9A4F"
        belly="#FFE08A"
        ears="horns"
        mood="grin"
        behind={
          <g stroke={INK} strokeWidth={SW} strokeLinejoin="round">
            <path d="M116 66 Q150 40 152 86 Q142 78 132 90 Q126 78 118 84 Z" fill="#FF9F43" />
            <path d="M118 126 Q152 134 150 106 Q160 122 148 140 Q132 148 116 138 Z" fill="#5BC46A" />
            <path d="M150 106 L158 98 L154 112 Z" fill="#FF9F43" />
          </g>
        }
      >
        <g stroke={INK} strokeWidth={SW} strokeLinejoin="round" strokeLinecap="round">
          <path d="M110 100 L96 124" strokeWidth="9" />
          <path d="M110 100 L96 124" stroke="#3B4150" strokeWidth="4" />
          <circle cx="116" cy="86" r="14" fill="#C9CED8" />
          <path d="M106 80 H126 M104 87 H128 M106 94 H126" stroke="#7D8697" strokeWidth="2" />
          {arm(104, 112, -30, '#5BC46A')}
          <path d="M138 66 Q148 80 138 94" fill="none" stroke="#FFD43B" strokeWidth="4" />
          <path d="M146 56 Q162 80 146 104" fill="none" stroke="#FFD43B" strokeWidth="4" opacity=".7" />
        </g>
        {arm(34, 108, 25, '#5BC46A')}
      </Critter>
    </Svg>
  );
}

/** Subscriptions / community — a headset buddy hugging a heart. */
export function BuddyHeart(p: ArtProps) {
  return (
    <Svg {...p}>
      <Critter body="#8E6CFF" shade="#6A4BD8" belly="#E3D9FF" ears="round" earInner="#C7B6FF">
        <g stroke={INK} strokeWidth={SW} strokeLinejoin="round" strokeLinecap="round">
          <path d="M38 82 Q36 26 80 26 Q124 26 122 82" fill="none" strokeWidth="6" />
          <path d="M38 82 Q36 26 80 26 Q124 26 122 82" fill="none" stroke="#2B2F3A" strokeWidth="3" />
          <rect x="28" y="72" width="14" height="22" rx="6" fill="#FFD43B" />
          <rect x="118" y="72" width="14" height="22" rx="6" fill="#FFD43B" />
          <path d="M80 140 C60 126 54 114 63 106 C70 100 77 104 80 110 C83 104 90 100 97 106 C106 114 100 126 80 140 Z" fill="#FF4D7E" />
          {arm(52, 118, 40, '#8E6CFF')}
          {arm(108, 118, -40, '#8E6CFF')}
          <path d="M136 36 l4 8 8 1 -6 6 2 8 -8 -4 -8 4 2 -8 -6 -6 8 -1 Z" fill="#FFD43B" strokeWidth="2.5" />
        </g>
      </Critter>
    </Svg>
  );
}

/** Moderation — a capped guardian with a check-mark shield. */
export function ShieldGuard(p: ArtProps) {
  return (
    <Svg {...p}>
      <Critter body="#3DA5FF" shade="#2179CC" belly="#D6ECFF" ears="none" mood="focus">
        <g stroke={INK} strokeWidth={SW} strokeLinejoin="round" strokeLinecap="round">
          <path d="M34 62 Q80 14 126 62 Z" fill="#1C3F7A" />
          <path d="M30 62 H130" strokeWidth="6" />
          <circle cx="80" cy="46" r="6" fill="#FFD43B" strokeWidth="2.5" />
          {arm(34, 108, 25, '#3DA5FF')}
          <path d="M112 90 L140 98 Q140 128 112 142 Q84 128 84 98 Z" fill="#FFD43B" />
          <path d="M100 116 L109 125 L125 106" fill="none" strokeWidth="5" />
        </g>
      </Critter>
    </Svg>
  );
}

/** All streamers — a gamer with a controller. */
export function GamerPad(p: ArtProps) {
  return (
    <Svg {...p}>
      <Critter body="#FF7A45" shade="#D95A28" belly="#FFE2C9" ears="pointy" earInner="#FFB38E" mood="grin">
        <g stroke={INK} strokeWidth={SW} strokeLinejoin="round" strokeLinecap="round">
          <path d="M40 58 Q80 22 120 58 Q80 48 40 58 Z" fill="#2B2F3A" />
          <path d="M40 58 Q24 58 20 66 Q32 68 44 64" fill="#2B2F3A" />
          <path d="M50 116 Q50 104 64 104 H96 Q110 104 110 116 L114 134 Q114 142 104 140 L96 132 H64 L56 140 Q46 142 46 134 Z" fill="#2B2F3A" />
          <path d="M62 114 V124 M57 119 H67" stroke="#F2F4F8" strokeWidth="3" />
          <circle cx="96" cy="114" r="3.5" fill="#FFD43B" strokeWidth="1.5" />
          <circle cx="104" cy="121" r="3.5" fill="#3DD9FF" strokeWidth="1.5" />
          <circle cx="90" cy="122" r="3.5" fill="#FF3D8B" strokeWidth="1.5" />
          {arm(42, 118, 20, '#FF7A45')}
          {arm(118, 118, -20, '#FF7A45')}
        </g>
      </Critter>
    </Svg>
  );
}

/** Become a streamer — an over-excited raccoon streamer (cartoon energy, fully original). */
export function RaccoonStreamer(p: ArtProps) {
  return (
    <Svg {...p}>
      <Critter
        body="#9AA3B5"
        shade="#6F788C"
        belly="#EEF0F5"
        ears="pointy"
        earInner="#2B2F3A"
        mood="grin"
        mask
        behind={
          <g stroke={INK} strokeWidth={SW} strokeLinejoin="round">
            <path d="M118 128 Q156 126 150 88 Q146 70 136 66 Q146 96 118 110 Z" fill="#9AA3B5" />
            <path d="M146 78 Q140 88 128 92 M150 96 Q142 106 124 110" fill="none" stroke="#2B2F3A" strokeWidth="7" />
          </g>
        }
      >
        <g stroke={INK} strokeWidth={SW} strokeLinejoin="round" strokeLinecap="round">
          <path d="M38 80 Q36 30 80 30 Q124 30 122 80" fill="none" strokeWidth="6" />
          <rect x="28" y="70" width="14" height="22" rx="6" fill="#FFD43B" />
          <rect x="118" y="70" width="14" height="22" rx="6" fill="#FFD43B" />
          <path d="M35 90 Q40 108 60 106" fill="none" strokeWidth="4" />
          <circle cx="62" cy="106" r="5" fill="#FF3D8B" strokeWidth="2.5" />
          {arm(26, 62, 35, '#9AA3B5')}
          {arm(134, 62, -35, '#9AA3B5')}
          <path d="M14 38 l3 7 7 1 -5 5 1 7 -6 -3 -6 3 1 -7 -5 -5 7 -1 Z" fill="#FFD43B" strokeWidth="2" />
        </g>
      </Critter>
    </Svg>
  );
}

/** Points & rewards — a cheerful coin. */
export function CoinBuddy(p: ArtProps) {
  return (
    <Svg {...p}>
      <g strokeLinejoin="round" strokeLinecap="round" stroke={INK} strokeWidth={SW}>
        <ellipse cx="80" cy="151" rx="40" ry="6" fill="#000" opacity=".35" stroke="none" />
        <circle cx="86" cy="92" r="50" fill="#C98A00" />
        <circle cx="80" cy="90" r="50" fill="#FFC928" />
        <circle cx="80" cy="90" r="38" fill="none" stroke="#E0A200" strokeWidth="4" />
        <ellipse cx="60" cy="62" rx="16" ry="8" fill="#fff" opacity=".4" stroke="none" transform="rotate(-30 60 62)" />
        <ellipse cx="66" cy="86" rx="7" ry="9" fill={INK} stroke="none" />
        <ellipse cx="94" cy="86" rx="7" ry="9" fill={INK} stroke="none" />
        <circle cx="68" cy="83" r="2.2" fill="#fff" stroke="none" />
        <circle cx="96" cy="83" r="2.2" fill="#fff" stroke="none" />
        <path d="M68 102 Q80 114 92 102" fill="none" strokeWidth="3" />
        <ellipse cx="54" cy="100" rx="6" ry="3.5" fill="#FF8F3D" opacity=".6" stroke="none" />
        <ellipse cx="106" cy="100" rx="6" ry="3.5" fill="#FF8F3D" opacity=".6" stroke="none" />
        <ellipse cx="26" cy="92" rx="8" ry="12" fill="#FFC928" transform="rotate(30 26 92)" />
        <ellipse cx="134" cy="84" rx="8" ry="12" fill="#FFC928" transform="rotate(-40 134 84)" />
        <ellipse cx="66" cy="143" rx="12" ry="7" fill="#E0A200" />
        <ellipse cx="96" cy="143" rx="12" ry="7" fill="#E0A200" />
        <path d="M140 30 l3 7 7 1 -5 5 1 7 -6 -3 -6 3 1 -7 -5 -5 7 -1 Z" fill="#fff" strokeWidth="2" />
        <path d="M22 40 l2 5 5 1 -4 3 1 5 -4 -2 -4 2 1 -5 -4 -3 5 -1 Z" fill="#FFD43B" strokeWidth="2" />
      </g>
    </Svg>
  );
}

/** Alerts / OBS — a ringing bell. */
export function BellAlert(p: ArtProps) {
  return (
    <Svg {...p}>
      <g strokeLinejoin="round" strokeLinecap="round" stroke={INK} strokeWidth={SW}>
        <ellipse cx="80" cy="151" rx="40" ry="6" fill="#000" opacity=".35" stroke="none" />
        <circle cx="80" cy="26" r="8" fill="#E0A200" />
        <path d="M80 30 C106 30 118 52 118 80 L118 104 L132 124 L28 124 L42 104 L42 80 C42 52 54 30 80 30 Z" fill="#FFD43B" />
        <path d="M34 116 H126 L132 124 H28 Z" fill="#E0A200" />
        <circle cx="80" cy="136" r="10" fill="#E0A200" />
        <ellipse cx="62" cy="54" rx="10" ry="6" fill="#fff" opacity=".4" stroke="none" transform="rotate(-30 62 54)" />
        <ellipse cx="68" cy="82" rx="6" ry="8" fill={INK} stroke="none" />
        <ellipse cx="92" cy="82" rx="6" ry="8" fill={INK} stroke="none" />
        <circle cx="70" cy="79" r="2" fill="#fff" stroke="none" />
        <circle cx="94" cy="79" r="2" fill="#fff" stroke="none" />
        <path d="M70 96 Q80 108 90 96 Z" fill="#3A0D16" strokeWidth="2.5" />
        <path d="M18 60 Q10 76 18 92 M142 60 Q150 76 142 92" fill="none" stroke="#FFD43B" strokeWidth="4" />
        <path d="M8 52 Q-2 76 8 100 M152 52 Q162 76 152 100" fill="none" stroke="#FFD43B" strokeWidth="4" opacity=".6" />
      </g>
    </Svg>
  );
}

/** Donations — a heart piggy with a coin. */
export function PiggyHeart(p: ArtProps) {
  return (
    <Svg {...p}>
      <Critter body="#FF8FB5" shade="#E0628F" belly="#FFE0EC" ears="pointy" earInner="#FF5C95">
        <g stroke={INK} strokeWidth={SW} strokeLinejoin="round" strokeLinecap="round">
          <ellipse cx="80" cy="112" rx="15" ry="10" fill="#FF6FA0" />
          <circle cx="75" cy="112" r="2.5" fill={INK} stroke="none" />
          <circle cx="85" cy="112" r="2.5" fill={INK} stroke="none" />
          <path d="M70 42 H90" strokeWidth="5" />
          <circle cx="124" cy="36" r="13" fill="#FFC928" />
          <path d="M124 29 V43 M119 33 Q124 29 129 33" fill="none" strokeWidth="2.5" />
          {arm(34, 110, 25, '#FF8FB5')}
          {arm(126, 110, -25, '#FF8FB5')}
        </g>
      </Critter>
    </Svg>
  );
}

/** Live queue — a DJ buddy with a play button. */
export function QueueDJ(p: ArtProps) {
  return (
    <Svg {...p}>
      <Critter body="#2FD3B4" shade="#1FA189" belly="#D5FFF5" ears="round" earInner="#9CF2E0">
        <g stroke={INK} strokeWidth={SW} strokeLinejoin="round" strokeLinecap="round">
          <path d="M38 82 Q36 26 80 26 Q124 26 122 82" fill="none" strokeWidth="6" />
          <rect x="26" y="70" width="16" height="26" rx="7" fill="#2B2F3A" />
          <rect x="118" y="70" width="16" height="26" rx="7" fill="#2B2F3A" />
          <rect x="56" y="108" width="48" height="34" rx="10" fill="#FFD43B" />
          <path d="M74 116 L90 125 L74 134 Z" fill={INK} strokeWidth="2" />
          {arm(50, 124, 30, '#2FD3B4')}
          {arm(110, 124, -30, '#2FD3B4')}
          <path d="M140 44 v18 M146 38 v30 M152 48 v10" stroke="#FFD43B" strokeWidth="4" />
        </g>
      </Critter>
    </Svg>
  );
}

/** Streamer dashboard — a camera operator. */
export function StudioCam(p: ArtProps) {
  return (
    <Svg {...p}>
      <Critter body="#B18CFF" shade="#8C66E0" belly="#EDE4FF" ears="pointy" earInner="#D9C8FF" mood="focus">
        <g stroke={INK} strokeWidth={SW} strokeLinejoin="round" strokeLinecap="round">
          <rect x="84" y="96" width="46" height="32" rx="7" fill="#2B2F3A" />
          <path d="M130 104 L148 96 V128 L130 120 Z" fill="#3B4150" />
          <circle cx="104" cy="112" r="10" fill="#3DD9FF" />
          <circle cx="104" cy="112" r="4" fill={INK} stroke="none" />
          <circle cx="124" cy="102" r="3.5" fill="#FF3D3D" strokeWidth="1.5" />
          {arm(86, 124, -20, '#B18CFF')}
          {arm(36, 110, 25, '#B18CFF')}
        </g>
      </Critter>
    </Svg>
  );
}

/** Tiny head used on the "Join Discord" pill. */
export function BuddyHead(p: ArtProps) {
  return (
    <Svg viewBox="22 22 116 100" {...p}>
      <Critter body="#8E6CFF" shade="#6A4BD8" belly="#8E6CFF" ears="round" earInner="#C7B6FF" mood="grin" />
    </Svg>
  );
}

/** Hero scene: the streamer raccoon and the mic dragon with floating coins. */
export function HeroScene(p: ArtProps) {
  return (
    <Svg viewBox="0 0 420 300" {...p}>
      <defs>
        <radialGradient id="heroGlow" cx=".55" cy=".55" r=".5">
          <stop offset="0" stopColor="#FFD43B" stopOpacity=".45" />
          <stop offset=".6" stopColor="#FFD43B" stopOpacity=".08" />
          <stop offset="1" stopColor="#FFD43B" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="230" cy="165" rx="190" ry="140" fill="url(#heroGlow)" />
      <circle cx="235" cy="160" r="112" fill="none" stroke="#FFD43B" strokeOpacity=".25" strokeWidth="2" strokeDasharray="4 10" />
      <g className="vx-float-slow">
        <RaccoonStreamer x="130" y="20" width="250" height="250" />
      </g>
      <g className="vx-float">
        <DragonMic x="20" y="120" width="160" height="160" />
      </g>
      <g className="vx-float-fast">
        <CoinBuddy x="330" y="10" width="80" height="80" />
      </g>
      <CoinBuddy x="30" y="40" width="48" height="48" opacity=".85" />
    </Svg>
  );
}
