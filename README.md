# Soccer Stars - Clon

Clon physics-based en Phaser 3 + Matter.js. Vista cenital, gravedad cero, mecanica slingshot por turnos.

## Como ejecutar

Doble click en `index.html`. Phaser se carga desde CDN, no hay build.

Si el navegador bloqueara el CDN:

```powershell
python -m http.server 8000
# luego abre http://localhost:8000/
```

## Como se juega

1. En el menu, eligves color y modo: **JUGAR LOCAL** (un PC), **CREAR SALA ONLINE** o **UNIRSE A SALA**.
2. El equipo activo aparece marcado arriba (ROJO o AZUL). En online, solo puedes mover tus chapas cuando es tu turno.
3. Click sobre una chapa propia, arrastra para apuntar (vector invertido tipo tirachinas), suelta para disparar.
4. Cuando todas las fichas se detienen, pasa el turno al rival.
5. Si la pelota cruza la linea de gol, se incrementa el marcador y el equipo que recibio el gol saca desde la formacion inicial.

## Multijugador online (gratis, sin servidor)

Usa **PeerJS** con su servidor publico de senalizacion (`cloud.peerjs.com`) y conexion **WebRTC peer-to-peer**. No hay que desplegar nada.

Flujo:

1. Jugador A pulsa **CREAR SALA ONLINE**, espera unos segundos a que aparezca el codigo y lo copia.
2. Se lo envia a Jugador B por cualquier medio (chat, email, etc.).
3. Jugador B pulsa **UNIRSE A SALA**, pega el codigo y pulsa CONECTAR.
4. Cuando ambos estan conectados, el juego arranca automaticamente para los dos.
5. El **host (creador de sala) juega rojo** con el color que eligio en el menu. El cliente juega azul.

Modelo de red: **lockstep en disparos + resync al final de cada turno**. Cuando uno dispara se envia el evento al rival y ambos simulan en paralelo. Como Matter.js no es 100% determinista entre maquinas, al detenerse todo el host envia el snapshot canonico (posiciones + marcador + turno) y el cliente sincroniza. Cualquier divergencia visual queda corregida cada vez que termina un turno.

Limitaciones:
- PeerJS publico esta sujeto a sus cuotas; en uso casual no se notan.
- NAT muy estricto / firewalls corporativos pueden bloquear la conexion P2P. Funciona bien en la mayoria de redes domesticas.
- El cliente puede ver brevemente confeti o shake "fantasma" si su simulacion local marca gol y el host no. Se corrige al recibir el sync.

Restricciones:
- Solo se puede mover una chapa del equipo en turno por jugada.
- Click dentro del radio de una chapa propia inicia el aiming; click en cualquier otro sitio se ignora.
- Click sin arrastre apreciable no consume turno.

## Implementado

- Campo 960x600 con porterias laterales en U y sensores de gol interiores.
- 5 chapas por equipo en formacion 1-2-2 (portero, 2 defensas, 2 delanteros).
- Balon ligero (50% del radio del jugador, masa 0.3) con `frictionAir` mas baja para que recorra mas.
- Slingshot con clamp de velocidad maxima y flecha predictiva con color que escala con la fuerza.
- Rebote contra paredes resuelto manualmente (reflexion axis-aligned con restitucion solo en la normal). Evita el efecto "se come el rebote" en angulos rasantes.
- FSM por turnos: `WAITING_FOR_INPUT` -> `PHYSICS_SIMULATION` -> deteccion de gol y reset / cambio de turno.
- Marcador y label de turno en HTML, sincronizados al final de cada simulacion.
- Reset completo de posiciones, velocidades lineales y angulares tras gol.

## Constantes para tunear

Editar la cabecera de `game.js`:

| Constante                | Que hace                                              |
|--------------------------|-------------------------------------------------------|
| `RESTITUTION`            | Rebote disco-disco (gestionado por Matter).           |
| `RESTITUTION_WALL`       | Rebote disco-pared (gestionado manualmente).          |
| `FRICTION_AIR_PLAYER`    | Cuanto frenan las chapas en el aire.                  |
| `FRICTION_AIR_BALL`      | Cuanto frena el balon. Mas bajo = mas recorrido.      |
| `STOP_THRESH`            | Umbral para considerar que un disco esta parado.      |
| `FORCE_MULT`             | Sensibilidad del slingshot (px arrastrados -> vel).   |
| `MAX_VELOCITY`           | Velocidad maxima de disparo.                          |
| `BALL_MASS` / `PLAYER_MASS` | Masa relativa: balon ligero reacciona mas al impacto. |
| `GOAL_HALF` / `GOAL_DEPTH` | Tamano del hueco y profundidad de la red.           |
| `FORMATION`              | Posiciones relativas [0..1] de las 5 chapas (espejado para el rival). |

## Arquitectura

- `index.html` - layout, marcador, indicador de turno y estado.
- `game.js` - configuracion Phaser/Matter, escena, fisica, UI logica.

Flujo de un turno:

```
WAITING_FOR_INPUT
  pointerdown sobre chapa propia -> selectedDisc + aiming
  pointermove -> dibuja flecha
  pointerup -> setVelocity con vector invertido + clamp -> PHYSICS_SIMULATION

PHYSICS_SIMULATION (cada frame)
  Matter resuelve colisiones disco-disco
  Listener manual sobreescribe rebotes contra paredes
  Listener de sensores de gol marca pendingGoal si entra el balon
  Cuando todas las velocidades < STOP_THRESH:
    - Si pendingGoal: marcador++, reset posiciones, saca el equipo conceding
    - Si no: alternar currentTeam
    - WAITING_FOR_INPUT
```

## Visual / VFX

- Cesped con bandas alternas (#1d3a11 / #2a5219), ruido sutil simulando briznas y vineteado oscuro en bordes. Generado en runtime con Canvas API y refrescado a textura Phaser.
- Lineas de cal con glow (3 capas: ancha+poca opacidad, media, fina+blanca al 100%).
- Porterias: red en rejilla 6px sobre fondo oscuro semitransparente, marco fino blanco, postes con simulacion de gradiente metalico (capas concentricas).
- Chapas no planas: gradiente radial (claro arriba-izquierda -> oscuro abajo-derecha) + reflejo de luz + punto especular + sombra elipsoidal proyectada.
- HUD con tipografia Orbitron, panel cristal con borde y glow neon.
- Menu principal estilo lobby con glassmorphism (backdrop-filter blur+saturate, bordes finos, sombras profundas) y transicion fade-to-black al jugar.
- Personalizacion: 4 colores para el equipo del jugador (rojo, naranja, morado, verde).

VFX:
- Particulas de gol: explosion de 140 confetis (8 colores) con rotacion, gravedad y fade.
- Screen shake fuerte en gol (280ms, 1.3% intensidad) y mas suave en impactos chapa-chapa de alta velocidad (170ms, 0.55%, con cooldown de 110ms para no encadenar).
- Shake de la red al detectar gol (~350ms, oscilacion +-3px).
- Estela (trail) que sigue a la chapa cuando se dispara con >=80% de la fuerza maxima.
- Capas claras: cesped < lineas < red < postes < trail < chapas < balon < highlight/mira < confeti.

## Pendiente / mejoras posibles

- Sonidos de impacto y de gol.
- Limite de tiempo o maximo de turnos por partido.
- IA rival basica.
- Animacion de "GOL!" en pantalla con tipografia neon.
- Botones en pantalla para reiniciar o volver al menu.
