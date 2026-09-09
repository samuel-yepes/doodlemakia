# Distrito Garabato (Doodle District)

Un shooter de supervivencia en primera persona dibujado con bolígrafo azul sobre papel de libreta cuadriculado. Desplázate con el gancho por tejados y cañones, desvía balas hacia los garabatos que las dispararon con tu katana, lanza granadas y pon a prueba cuántas oleadas puedes sobrevivir. Juega en solitario, sobrevive con amigos o enfréntate a ellos.

Todo lo que ves está generado por código mediante three.js. No hay modelos 3D, texturas ni archivos de sonido externos: el papel, los trazos de tinta, el sombreado rayado, los enemigos y la música son totalmente procedimentales, incluidos los temas de 8 bits para cada mapa (actívalos en ajustes o con la tecla M).

## Cómo ejecutarlo

Es un sitio web estático, por lo que cualquier servidor web sirve.

### Con Node.js / npm:
```bash
npm start
# o:
npm run dev
```

### Con Python:
```bash
python serve.py 8910
```
Luego abre en tu navegador `http://127.0.0.1:8910`. En Vercel o cualquier hosting de sitios estáticos, simplemente despliega la carpeta tal cual.

## Modos de Juego

- **En solitario**: sobrevive a las oleadas. Hay jefes cada 5 oleadas y los puntos de control se desbloquean en las oleadas 5, 10, 15...
- **Todos contra todos (Multijugador)**: hasta 10 jugadores, el primero en llegar a 20 bajas gana, con un límite de 10 minutos que inicia cuando entra un segundo jugador. Cualquiera en la sala puede iniciar la partida. Tras la cámara de muerte, pulsar cualquier botón te hace reaparecer con 2 segundos de escudo; dos minutos y medio sin actividad te expulsan por inactividad, con opción de reconexión en un clic. La salud se regenera tras unos segundos fuera de combate (excepto mientras esprintas), por lo que solo cae munición en el mapa.

El multijugador funciona punto a punto (P2P) mediante WebRTC (PeerJS), funcionando en hosts estáticos sin necesidad de servidor de juego dedicado. En **JUGAR EN LÍNEA** puedes usar Partida rápida (se une a una sala pública o crea una para ti), crear una sala pública o privada, o unirte a la sala de un amigo mediante su código de 5 letras. Es posible unirse a partidas ya en curso. El navegador del anfitrión gestiona las puntuaciones mientras cada jugador procesa su propia física.

## Controles

| Acción | Ratón + Teclado | Mando PS5 |
| --- | --- | --- |
| Moverse / Mirar / Esprintar | WASD, Ratón, Shift | Stick Izq, Stick Der, L3 |
| Disparar / Tajo | Clic Izquierdo | R2 |
| Apuntar / Bloquear (katana) | Clic Derecho | L2 |
| Saltar, salto en pared, doble salto | Espacio | ✕ |
| Deslizarse, embestida aérea | C / Ctrl (X, Alt) | ○ |
| Gancho (mantener para recoger) | Q / E | L1 |
| Tajo rápido de katana | F | R1 |
| Recargar | R | □ |
| Granada (mantener para mayor distancia) | G | R3 o D-pad Arriba |
| Embestida de katana (barra llena) | Ambos botones del ratón o X | L2 + R2 |
| Cambiar arma | 1-4 / Rueda del ratón | △, cruceta |
| Marcador (multijugador) | Tab | Create |
| Menú / Pausa | Esc | Options |

Las pistas en pantalla se adaptan al último dispositivo de entrada que hayas utilizado.

## Armas y Equipamiento

Fusil, escopeta, francotirador (con mira telescópica) y katana. Mantener el bloqueo con la katana para algunas balas enemigas y devuelve una parte de ellas a quien disparó. Las bajas con katana cargan un medidor; cuando está listo, puedes abalanzarte sobre un enemigo fijado y ejecutarlo (solo en modo solitario). Las granadas rebotan y estallan en una densa explosión naranja que quema el papel; mantener presionado el botón calcula un tiro más largo mostrando la parábola. El gancho consume resistencia: colgarse la gasta, tocar el suelo la recupera y cortar la cuerda de un rival con la katana se la rompe. Contra otros jugadores, alzar la katana desvía tajos y balas, con tablas de daño específicas para armas de fuego; el francotirador elimina de un tiro a la cabeza.

## Mapas

- **Distrito Garabato**: calles, azoteas y escaleras de incendio, con aros de agarre en zonas elevadas. En solitario juegas en la manzana central. En multijugador se abre el mapa completo: una calle circular perimetral, paredes, una cúpula estriada que no se puede enganchar, una plaza central atravesada por un puente de regla escolar, plataformas suspendidas y aviones de papel en los que puedes engancharte y viajar.
- **Garabato México**: un pueblo bañado por el sol. Una plaza con fuente y un sombrero gigante flotante, un quiosco donde tres mariachis no dejan de tocar, una iglesia con campanario escalable y torre con cúpula, casas de adobe con escaleras, papel picado tendido por la plaza, puestos de mercado con piñatas colgantes, un carrito de tacos, cactus y mesetas alrededor. Ollas, cajas, barriles, cactus y piñatas se rompen con balas o explosiones; las piñatas sueltan tacos, que sirven como botiquines de salud. Cuenta con su propio vals de mariachi procedural.

Elige el mapa en el menú principal para la partida en solitario; en multijugador, el anfitrión lo escoge en la sala y todos inician en puntos aleatorios.

## Enemigos

Reclutas, asaltantes, bombarderos, francotiradores con punteros láser esquivables, avispas de papel voladoras, blindados pesados y portadores de escudo. Jefes rotativos: El Garabateador, El Borrador y La Mancha de Tinta, cada uno con patrones de ataque propios.

## Cómo funciona el apartado visual

La escena se renderiza en un búfer que almacena sombreado, identificador de tinta, normales en espacio de vista y profundidad flotante. Una pasada de posprocesado dibuja los contornos usando un operador laplaciano de profundidad inversa, agrega sombreado rayado que sigue las superficies, grano de papel, líneas de libreta rayada y el margen rojo. El efecto de vibración es estático para que nada parpadee.
