import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The launch field: a swarm of resume-missiles climbing out of a grid floor into the dark,
 * with mouse parallax and scroll-driven acceleration. Renders into a fixed canvas behind the
 * landing page. Loaded lazily so the app bundle never pays for three.js.
 */

const OLIVE = 0x2f3522;
const ORANGE = 0xe8590c;
const BONE = 0xeee8d5;
const KHAKI = 0x9c9271;

const COUNT = 320;
const SPAN_X = 44;
const SPAN_Z = 36;
const FLOOR_Y = -14;
const CEIL_Y = 22;

function colored(geometry: THREE.BufferGeometry, hex: number) {
  const g = geometry.toNonIndexed();
  const n = g.getAttribute('position').count;
  const c = new THREE.Color(hex);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

/** One missile: a bone body, an orange nose cone, two orange fins and a khaki tail. */
function missileGeometry() {
  const body = colored(new THREE.BoxGeometry(0.5, 1.5, 0.08), BONE);
  const nose = colored(new THREE.ConeGeometry(0.3, 0.6, 4), ORANGE);
  nose.rotateY(Math.PI / 4);
  nose.translate(0, 1.05, 0);
  const tail = colored(new THREE.BoxGeometry(0.2, 0.4, 0.08), KHAKI);
  tail.translate(0, -0.95, 0);
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.lineTo(0.42, -0.5);
  finShape.lineTo(0, -0.28);
  const finL = colored(new THREE.ShapeGeometry(finShape), ORANGE);
  finL.translate(0.25, -0.35, 0);
  const finR = finL.clone();
  finR.scale(-1, 1, 1);
  // Resume lines etched into the body, slightly proud of the surface.
  const lines: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const w = i === 3 ? 0.22 : 0.32;
    const line = colored(new THREE.BoxGeometry(w, 0.045, 0.02), OLIVE);
    line.translate(i === 3 ? -0.05 : 0, 0.45 - i * 0.26, 0.05);
    lines.push(line);
  }
  const merged = mergeGeometries([body, nose, tail, finL, finR, ...lines], false);
  if (!merged) throw new Error('missile geometry failed to merge');
  merged.computeVertexNormals();
  return merged;
}

export function LaunchField({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x16181a, 0.022);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    camera.position.set(0, -2, 34);
    const look = new THREE.Vector3(0, 2, 0);

    scene.add(new THREE.HemisphereLight(0xeee8d5, 0x2f3522, 1.1));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.2);
    key.position.set(8, 14, 12);
    scene.add(key);
    const rim = new THREE.PointLight(ORANGE, 40, 60, 2);
    rim.position.set(-10, -8, 6);
    scene.add(rim);

    // The grid floor the swarm lifts off from.
    const grid = new THREE.GridHelper(160, 64, KHAKI, OLIVE);
    grid.position.y = FLOOR_Y;
    const gridMat = grid.material as THREE.LineBasicMaterial;
    gridMat.transparent = true;
    gridMat.opacity = 0.35;
    scene.add(grid);

    // Dust: tiny bone points drifting upward, slower than the missiles.
    const dustCount = 900;
    const dustPos = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
      dustPos[i * 3] = (Math.random() - 0.5) * 90;
      dustPos[i * 3 + 1] = FLOOR_Y + Math.random() * (CEIL_Y - FLOOR_Y + 10);
      dustPos[i * 3 + 2] = (Math.random() - 0.5) * 70 - 10;
    }
    const dustGeo = new THREE.BufferGeometry();
    const dustAttr = new THREE.BufferAttribute(dustPos, 3);
    dustGeo.setAttribute('position', dustAttr);
    const dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({
        color: BONE,
        size: 0.09,
        transparent: true,
        opacity: 0.55,
        sizeAttenuation: true,
      }),
    );
    scene.add(dust);

    // The swarm.
    const geo = missileGeometry();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.08,
    });
    const swarm = new THREE.InstancedMesh(geo, mat, COUNT);
    swarm.frustumCulled = false;
    scene.add(swarm);

    // Exhaust: one orange point per missile, trailing just below the tail.
    const exhaustPos = new Float32Array(COUNT * 3);
    const exhaustGeo = new THREE.BufferGeometry();
    const exhaustAttr = new THREE.BufferAttribute(exhaustPos, 3);
    exhaustGeo.setAttribute('position', exhaustAttr);
    const exhaust = new THREE.Points(
      exhaustGeo,
      new THREE.PointsMaterial({
        color: ORANGE,
        size: 0.5,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    scene.add(exhaust);

    type Bird = {
      x: number;
      y: number;
      z: number;
      v: number;
      sway: number;
      phase: number;
      scale: number;
      spin: number;
    };
    const birds: Bird[] = [];
    for (let i = 0; i < COUNT; i++) {
      birds.push({
        x: (Math.random() - 0.5) * SPAN_X,
        y: FLOOR_Y + Math.random() * (CEIL_Y - FLOOR_Y),
        z: (Math.random() - 0.5) * SPAN_Z - 6,
        v: 2.2 + Math.random() * 3.2,
        sway: 0.25 + Math.random() * 0.6,
        phase: Math.random() * Math.PI * 2,
        scale: 0.6 + Math.random() * 0.7,
        spin: (Math.random() - 0.5) * 0.6,
      });
    }

    const dummy = new THREE.Object3D();
    const euler = new THREE.Euler();

    let pointerX = 0;
    let pointerY = 0;
    let targetX = 0;
    let targetY = 0;
    let scrollBoost = 0;
    let scrollTarget = 0;
    let lastScroll = window.scrollY;

    const onPointer = (e: PointerEvent) => {
      targetX = (e.clientX / window.innerWidth - 0.5) * 2;
      targetY = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    const onScroll = () => {
      const y = window.scrollY;
      scrollTarget = Math.min(6, scrollTarget + Math.abs(y - lastScroll) * 0.02);
      lastScroll = y;
    };
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });

    const resize = () => {
      const w = el.clientWidth || window.innerWidth;
      const h = el.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const clock = new THREE.Clock();
    let frame = 0;
    let running = true;

    const step = () => {
      if (!running) return;
      frame = requestAnimationFrame(step);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      const motion = reduced.matches ? 0.15 : 1;

      scrollTarget *= 0.96;
      scrollBoost += (scrollTarget - scrollBoost) * 0.08;
      pointerX += (targetX - pointerX) * 0.04;
      pointerY += (targetY - pointerY) * 0.04;

      const speed = (1 + scrollBoost) * motion;
      for (let i = 0; i < COUNT; i++) {
        const b = birds[i]!;
        b.y += b.v * speed * dt;
        if (b.y > CEIL_Y) {
          b.y = FLOOR_Y - Math.random() * 6;
          b.x = (Math.random() - 0.5) * SPAN_X;
          b.z = (Math.random() - 0.5) * SPAN_Z - 6;
        }
        const sx = Math.sin(t * 0.9 + b.phase) * b.sway;
        const lean = Math.cos(t * 0.9 + b.phase) * 0.18;
        dummy.position.set(b.x + sx, b.y, b.z);
        euler.set(0, t * b.spin + b.phase, lean);
        dummy.rotation.copy(euler);
        dummy.scale.setScalar(b.scale);
        dummy.updateMatrix();
        swarm.setMatrixAt(i, dummy.matrix);
        exhaustPos[i * 3] = b.x + sx;
        exhaustPos[i * 3 + 1] = b.y - 1.25 * b.scale;
        exhaustPos[i * 3 + 2] = b.z;
      }
      swarm.instanceMatrix.needsUpdate = true;
      exhaustAttr.needsUpdate = true;

      for (let i = 0; i < dustCount; i++) {
        const y = (dustPos[i * 3 + 1] ?? FLOOR_Y) + 0.6 * speed * dt;
        dustPos[i * 3 + 1] = y > CEIL_Y + 10 ? FLOOR_Y : y;
      }
      dustAttr.needsUpdate = true;

      camera.position.x = pointerX * 3.5;
      camera.position.y = -2 - pointerY * 2 - scrollBoost * 0.4;
      camera.lookAt(look);
      grid.position.z = ((t * 1.5 * speed) % 2.5) - 1.25;

      renderer.render(scene, camera);
    };
    step();

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frame);
      } else if (!running) {
        running = true;
        clock.getDelta();
        step();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('scroll', onScroll);
      ro.disconnect();
      geo.dispose();
      mat.dispose();
      dustGeo.dispose();
      exhaustGeo.dispose();
      (dust.material as THREE.Material).dispose();
      (exhaust.material as THREE.Material).dispose();
      grid.geometry.dispose();
      gridMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={host} className={className} aria-hidden="true" />;
}

export default LaunchField;
