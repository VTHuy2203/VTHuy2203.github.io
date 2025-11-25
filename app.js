// --- Global Variables and Constants ---
const RENDER_STEP = 1 / 60;
const WORLD_SIZE = 15;
const INITIAL_CAMERA_Y = 5;

let camera, scene, renderer;
let world, fixedTimeStep = 1 / 60, maxSubSteps = 3;

// Physics/Visual Synchronization Arrays
const meshes = [];
const bodies = [];

// Camera Movement State
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const move = { forward: false, backward: false, left: false, right: false, up: false, down: false };
let prevTime = performance.now();
// Reduced movement speed for better control
const movementSpeed = 5;

// Mouse Look State
let pointerLocked = false;
const PI_2 = Math.PI / 2;
let rotationX = 0;
let rotationY = 0;

// Picking/Holding State
let isHolding = false;
let heldBody = null;
let heldConstraint = null;
let pickDistance = 5; // Initial distance for the held object
// INCREASED: Throw strength is now much higher for a powerful flick
const throwStrength = 200; 

// Flick/Throw Velocity Tracking
const mouseMovements = [];
const maxMovementTrack = 5; // Track last 5 mouse moves

// Object Spawning
let objectTypeIndex = 0;
const objectTypes = ['Box', 'Sphere', 'Cylinder', 'Cone'];
const crosshair = document.getElementById('crosshair');

// --- Utility Functions ---

/** Converts THREE.Vector3 to CANNON.Vec3 and vice versa */
const toCannonVec = (v) => new CANNON.Vec3(v.x, v.y, v.z);
const toThreeVec = (v) => new THREE.Vector3(v.x, v.y, v.z);

/** Converts base64 PCM audio data to WAV format (required for TTS) */
function pcmToWav(pcm16, sampleRate) {
    const buffer = new ArrayBuffer(44 + pcm16.byteLength);
    const view = new DataView(buffer);

    /* RIFF identifier */
    writeString(view, 0, 'RIFF');
    /* file length */
    view.setUint32(4, 36 + pcm16.byteLength, true);
    /* RIFF type */
    writeString(view, 8, 'WAVE');
    /* format chunk identifier */
    writeString(view, 12, 'fmt ');
    /* format chunk length */
    view.setUint32(16, 16, true);
    /* sample format (1 = PCM) */
    view.setUint16(20, 1, true);
    /* channel count */
    view.setUint16(22, 1, true); /* Mono */
    /* sample rate */
    view.setUint32(24, sampleRate, true);
    /* byte rate (sample rate * block align) */
    view.setUint32(28, sampleRate * 2, true);
    /* block align (channels * bytes per sample) */
    view.setUint16(32, 2, true);
    /* bits per sample */
    view.setUint16(34, 16, true); /* 16 bit */
    /* data chunk identifier */
    writeString(view, 36, 'data');
    /* data chunk length */
    view.setUint32(40, pcm16.byteLength, true);
    /* write pcm data */
    let offset = 44;
    for (let i = 0; i < pcm16.length; i++) {
        view.setInt16(offset, pcm16[i], true);
        offset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });

    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }
}


// --- Initialization ---

function init() {
    // 1. Setup Three.js (Scene, Camera, Renderer)
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, INITIAL_CAMERA_Y, 0);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);
    scene.fog = new THREE.Fog(0x1a1a2e, 0, WORLD_SIZE * 2);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    document.body.appendChild(renderer.domElement);

    // 2. Setup Lights
    
    // Increased Ambient Light significantly
    const ambient = new THREE.AmbientLight(0xffffff, 0.7); 
    scene.add(ambient);
    
    // Increased Hemisphere Light intensity to dramatically brighten the non-shadowed areas
    const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
    scene.add(hemisphereLight);

    const spotLight = new THREE.SpotLight(0xffffff, 1.2, 0, Math.PI / 8, 0.5, 1);
    spotLight.position.set(WORLD_SIZE * 0.8, WORLD_SIZE * 2, WORLD_SIZE * 0.8);
    spotLight.castShadow = true;
    spotLight.shadow.mapSize.width = 2048;
    spotLight.shadow.mapSize.height = 2048;
    scene.add(spotLight);

    // 3. Setup Cannon.js (World)
    world = new CANNON.World();
    world.gravity.set(0, -9.82, 0);
    world.broadphase = new CANNON.SAPBroadphase(world);

    // 4. Create World Boundaries (A giant box)
    createBoundaries();

    // 5. Setup Event Listeners
    setupEventListeners();

    // Initial object spawn
    spawnObject();
}

function createBoundaries() {
    const material = new THREE.MeshPhongMaterial({ color: 0x444444, side: THREE.DoubleSide });
    const floorMaterial = new THREE.MeshPhongMaterial({ color: 0x333333, side: THREE.DoubleSide });
    const size = WORLD_SIZE * 2;
    const floorDepth = 0.5;

    // Cannon.js Plane/Floor
    const groundBody = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Plane(),
        position: new CANNON.Vec3(0, -floorDepth / 2, 0),
        material: new CANNON.Material({ friction: 0.8, restitution: 0.3 })
    });
    groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2); // Rotate to be horizontal
    world.addBody(groundBody);

    // Three.js Floor Mesh
    const floorMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        floorMaterial
    );
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.receiveShadow = true;
    floorMesh.position.y = -floorDepth / 2;
    scene.add(floorMesh);

    // Walls (Cannon.js Box)
    const wallDepth = 0.1;
    const wallMaterial = new CANNON.Material({ friction: 0.1, restitution: 0.9 });
    const halfSize = WORLD_SIZE;

    const wallConfig = [
        // Front Wall (Z+)
        { pos: new CANNON.Vec3(0, halfSize, halfSize), quat: new CANNON.Quaternion() },
        // Back Wall (Z-)
        { pos: new CANNON.Vec3(0, halfSize, -halfSize), quat: new CANNON.Quaternion() },
        // Left Wall (X-)
        { pos: new CANNON.Vec3(-halfSize, halfSize, 0), quat: new CANNON.Quaternion(0, 0.7071068, 0, 0.7071068) },
        // Right Wall (X+)
        { pos: new CANNON.Vec3(halfSize, halfSize, 0), quat: new CANNON.Quaternion(0, 0.7071068, 0, 0.7071068) },
        // Ceiling (Y+)
        { pos: new CANNON.Vec3(0, halfSize * 2 - floorDepth / 2, 0), quat: new CANNON.Quaternion(0.7071068, 0, 0, 0.7071068) }
    ];

    const wallShape = new CANNON.Box(new CANNON.Vec3(halfSize, halfSize, wallDepth));

    wallConfig.forEach(config => {
        const wallBody = new CANNON.Body({ mass: 0, shape: wallShape, material: wallMaterial });
        wallBody.position.copy(config.pos);
        wallBody.quaternion.copy(config.quat);
        world.addBody(wallBody);

        // Add visual mesh (optional, for visibility)
        const wallMesh = new THREE.Mesh(
            new THREE.BoxGeometry(halfSize * 2, halfSize * 2, wallDepth * 2),
            material.clone()
        );
        wallMesh.position.copy(toThreeVec(wallBody.position));
        wallMesh.quaternion.copy(wallBody.quaternion);
        wallMesh.receiveShadow = true;
        // Slightly less transparent walls to catch more light
        wallMesh.material.transparent = true; 
        wallMesh.material.opacity = 0.2; 
        scene.add(wallMesh);
    });
}

// --- Object Factory ---

function createObject(type, position, mass = 5) {
    let geometry, shape, material;
    const size = 1;
    const color = Math.random() * 0xffffff;
    const physMaterial = new CANNON.Material({ friction: 0.5, restitution: 0.5 });

    switch (type) {
        case 'Box':
            geometry = new THREE.BoxGeometry(size, size, size);
            shape = new CANNON.Box(new CANNON.Vec3(size / 2, size / 2, size / 2));
            break;
        case 'Sphere':
            geometry = new THREE.SphereGeometry(size / 2, 16, 16);
            shape = new CANNON.Sphere(size / 2);
            break;
        case 'Cylinder':
            geometry = new THREE.CylinderGeometry(size / 2, size / 2, size, 16);
            shape = new CANNON.Cylinder(size / 2, size / 2, size, 16);
            break;
        case 'Cone':
            geometry = new THREE.ConeGeometry(size / 2, size, 16);
            shape = new CANNON.Cylinder(0, size / 2, size, 16); // Cannon uses Cylinder with zero top radius for Cone
            break;
        default:
            return;
    }

    material = new THREE.MeshPhongMaterial({ color: color, shininess: 80 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.isRigidBody = true; // For raycasting

    const body = new CANNON.Body({
        mass: mass,
        shape: shape,
        position: toCannonVec(position),
        material: physMaterial
    });

    // Set initial velocity slightly randomized to prevent them stacking perfectly
    body.velocity.set(Math.random() - 0.5, 0, Math.random() - 0.5);

    world.addBody(body);
    scene.add(mesh);
    bodies.push(body);
    meshes.push(mesh);
}

function spawnObject() {
    if (bodies.length > 50) return; // Prevent too many objects

    const type = objectTypes[objectTypeIndex];
    objectTypeIndex = (objectTypeIndex + 1) % objectTypes.length;

    const spawnPos = new THREE.Vector3(
        camera.position.x + Math.random() * 0.5,
        camera.position.y,
        camera.position.z + Math.random() * 0.5
    );
    createObject(type, spawnPos, 5); // Default mass 5
}


// --- Interaction Logic (Grab, Throw, Distance) ---

function getRaycasterTarget() {
    // Get the center of the screen in normalized coordinates (0, 0)
    const center = new THREE.Vector2(0, 0);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(center, camera);
    raycaster.far = 10; // Only look for objects nearby

    const intersects = raycaster.intersectObjects(meshes);

    if (intersects.length > 0) {
        const mesh = intersects[0].object;
        const index = meshes.indexOf(mesh);
        if (index > -1) {
            return { mesh: mesh, body: bodies[index], point: intersects[0].point };
        }
    }
    return null;
}

function grabObject(target) {
    if (isHolding) return;

    isHolding = true;
    heldBody = target.body;

    // Prevent held object from colliding strongly
    heldBody.material.restitution = 0.1;
    heldBody.material.friction = 0.1;

    // Make the visual object indicate it's being held
    crosshair.classList.add('held-indicator');
    target.mesh.material.emissive.setHex(0x333300);


    // 1. Calculate the distance and hold position (pivot point)
    pickDistance = camera.position.distanceTo(target.mesh.position);
    pickDistance = Math.max(2, Math.min(10, pickDistance)); // Clamp between 2 and 10

    const localPivot = toCannonVec(target.mesh.worldToLocal(target.point.clone()));

    // 2. Create the constraint target position based on camera direction
    const worldTarget = new THREE.Vector3(0, 0, -pickDistance).applyQuaternion(camera.quaternion).add(camera.position);
    const constraintBody = new CANNON.Body({ mass: 0, position: toCannonVec(worldTarget) });
    world.addBody(constraintBody);

    // 3. Create a PointToPointConstraint
    heldConstraint = new CANNON.PointToPointConstraint(
        heldBody, localPivot,
        constraintBody, new CANNON.Vec3(0, 0, 0)
    );
    world.addConstraint(heldConstraint);
    heldConstraint.constraintBody = constraintBody; // Attach the temporary body for clean-up

    // 4. Update the target position every step
    heldConstraint.preStep = () => {
        // Calculate new target position
        const newWorldTarget = new THREE.Vector3(0, 0, -pickDistance).applyQuaternion(camera.quaternion).add(camera.position);
        constraintBody.position.copy(toCannonVec(newWorldTarget));
    };
}

function releaseObject() {
    if (!isHolding) return;

    // 1. Calculate average flick velocity
    if (mouseMovements.length > 1) {
        let totalX = 0, totalY = 0;
        for (let i = 0; i < mouseMovements.length; i++) {
            totalX += mouseMovements[i].x;
            totalY += mouseMovements[i].y;
        }
        const avgX = totalX / mouseMovements.length;
        const avgY = totalY / mouseMovements.length;

        // Create a vector representing the flick direction and strength
        const flickVector = new THREE.Vector3(avgX * 0.05, -avgY * 0.05, -1).normalize();
        flickVector.applyQuaternion(camera.quaternion);
        flickVector.multiplyScalar(throwStrength);

        // 2. Apply impulse
        heldBody.velocity.set(0, 0, 0); // Clear current velocity
        heldBody.applyImpulse(toCannonVec(flickVector), heldBody.position);
    }

    // 3. Clean up
    world.removeConstraint(heldConstraint);
    world.removeBody(heldConstraint.constraintBody);
    heldConstraint = null;
    heldBody.material.restitution = 0.5; // Restore
    heldBody.material.friction = 0.5;
    heldBody = null;
    isHolding = false;
    crosshair.classList.remove('held-indicator');
    mouseMovements.length = 0;

    // Reset emissive color (find the mesh and reset)
    const heldMeshIndex = bodies.indexOf(heldBody);
    if (heldMeshIndex > -1) {
        meshes[heldMeshIndex].material.emissive.setHex(0x000000);
    }
}

function updateHoldDistance(delta) {
    if (isHolding) {
        pickDistance = Math.max(2, Math.min(10, pickDistance + delta * 0.5));
    }
}

// --- Event Handlers ---

function setupEventListeners() {
    // Pointer Lock for Camera Control
    renderer.domElement.addEventListener('click', () => {
        if (!pointerLocked) {
            renderer.domElement.requestPointerLock();
        }
    });

    document.addEventListener('pointerlockchange', () => {
        pointerLocked = document.pointerLockElement === renderer.domElement;
        crosshair.style.display = pointerLocked ? 'block' : 'none';
    });

    // Camera Rotation (Mouse Look)
    document.addEventListener('mousemove', onMouseMove);

    // Object Interaction (Grab/Release)
    document.addEventListener('mousedown', onMouseDown, false);
    document.addEventListener('mouseup', onMouseUp, false);

    // Hold Distance (Mouse Scroll)
    document.addEventListener('wheel', onMouseWheel, false);

    // Camera Movement (Keys)
    document.addEventListener('keydown', onKeyDown, false);
    document.addEventListener('keyup', onKeyUp, false);

    // Window Resize
    window.addEventListener('resize', onWindowResize, false);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function onMouseMove(event) {
    if (!pointerLocked) return;

    const movementX = event.movementX || event.mozMovementX || event.webkitMovementX || 0;
    const movementY = event.movementY || event.mozMovementY || event.webkitMovementY || 0;

    rotationX -= movementX * 0.002;
    rotationY -= movementY * 0.002;

    // Clamp vertical rotation (Pitch)
    rotationY = Math.max(-PI_2, Math.min(PI_2, rotationY));

    // --- Camera Rotation Update: Enforce Yaw (Y) and Pitch (X) only, eliminating Roll (Z) ---
    const tempEuler = new THREE.Euler(rotationY, rotationX, 0, 'YXZ');
    camera.quaternion.setFromEuler(tempEuler);

    // Track movements for flicking (only when holding an object)
    if (isHolding) {
        mouseMovements.push({ x: movementX, y: movementY });
        if (mouseMovements.length > maxMovementTrack) {
            mouseMovements.shift();
        }
    }
}

function onMouseDown(event) {
    if (!pointerLocked || event.button !== 0) return; // Left click only

    const target = getRaycasterTarget();
    if (target) {
        grabObject(target);
    }
}

function onMouseUp(event) {
    if (!pointerLocked || event.button !== 0) return; // Left click only

    if (isHolding) {
        releaseObject();
    }
}

function onMouseWheel(event) {
    if (!pointerLocked) return;
    const delta = event.deltaY > 0 ? 1 : -1;
    updateHoldDistance(delta);
}

function onKeyDown(event) {
    switch (event.code) {
        case 'KeyW': move.forward = true; break;
        case 'KeyA': move.left = true; break;
        case 'KeyS': move.backward = true; break;
        case 'KeyD': move.right = true; break;
        case 'Space': move.up = true; break;
        case 'ShiftLeft':
        case 'ShiftRight': move.down = true; break;
        case 'KeyE': spawnObject(); break;
    }
}

function onKeyUp(event) {
    switch (event.code) {
        case 'KeyW': move.forward = false; break;
        case 'KeyA': move.left = false; break;
        case 'KeyS': move.backward = false; break;
        case 'KeyD': move.right = false; break;
        case 'Space': move.up = false; break;
        case 'ShiftLeft':
        case 'ShiftRight': move.down = false; break;
    }
}

// --- Animation Loop ---

function animate() {
    requestAnimationFrame(animate);

    const time = performance.now();
    const delta = (time - prevTime) / 1000;

    if (pointerLocked) {
        // 1. Physics Step
        world.step(fixedTimeStep, delta, maxSubSteps);
        updatePhysicsAndVisuals();
        updateCameraPosition(delta);
    } else {
        // Keep objects still if camera is not locked (saves CPU)
        renderer.render(scene, camera);
    }

    prevTime = time;
    renderer.render(scene, camera);
}

function updatePhysicsAndVisuals() {
    // 1. Sync Three.js Meshes with Cannon.js Bodies
    for (let i = 0; i < meshes.length; i++) {
        meshes[i].position.copy(toThreeVec(bodies[i].position));
        meshes[i].quaternion.copy(bodies[i].quaternion);

        // Highlight grabbed object
        if (isHolding && bodies[i] === heldBody) {
            meshes[i].material.emissive.setHex(0x333300);
        } else {
            meshes[i].material.emissive.setHex(0x000000);
        }
    }

    // 2. Update Held Object Constraint target
    if (isHolding && heldConstraint && heldConstraint.constraintBody) {
        const newWorldTarget = new THREE.Vector3(0, 0, -pickDistance).applyQuaternion(camera.quaternion).add(camera.position);
        heldConstraint.constraintBody.position.copy(toCannonVec(newWorldTarget));
    }
}

function updateCameraPosition(delta) {
    // Apply friction and reset velocity for smooth movement
    velocity.x -= velocity.x * 10.0 * delta;
    velocity.z -= velocity.z * 10.0 * delta;
    velocity.y -= velocity.y * 10.0 * delta;

    direction.z = Number(move.forward) - Number(move.backward);
    direction.x = Number(move.right) - Number(move.left);
    direction.y = Number(move.up) - Number(move.down);
    direction.normalize(); // Ensure constant speed when moving diagonally

    if (move.forward || move.backward) velocity.z -= direction.z * movementSpeed * delta;
    // D moves right (positive X relative to camera), A moves left (negative X relative to camera)
    if (move.left || move.right) velocity.x += direction.x * movementSpeed * delta; 
    if (move.up || move.down) velocity.y += direction.y * movementSpeed * delta;

    // Rotate velocity vector based on camera rotation
    camera.translateX(velocity.x);
    camera.translateY(velocity.y);
    camera.translateZ(velocity.z);

    // Keep camera above the floor
    if (camera.position.y < 1) {
        camera.position.y = 1;
        velocity.y = 0;
    }

    // Keep camera within the bounded box
    const halfSize = WORLD_SIZE - 0.5;
    camera.position.x = Math.max(-halfSize, Math.min(halfSize, camera.position.x));
    camera.position.z = Math.max(-halfSize, Math.min(halfSize, camera.position.z));
    camera.position.y = Math.min(WORLD_SIZE * 2 - 1, camera.position.y);
}

// --- Start Simulation ---
window.onload = function () {
    init();
    animate();
};
