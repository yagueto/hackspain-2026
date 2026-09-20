# HackSpain 2026 — ¿Puede la IA gestionar una crisis?

> [!IMPORTANT]
> **¿Por qué la demo pública utiliza datos mock?**
>
> La versión original está configurada con los **números de teléfono personales del equipo** para probar las llamadas reales. Publicarla tal cual permitiría que quienes accedieran a la demo activasen llamadas a nuestros teléfonos.
>
> Por privacidad, hemos desplegado el mismo proyecto con **datos ficticios (mocks)** en lugar de nuestros contactos reales. Así se puede explorar la experiencia sin exponer esa configuración. Las capacidades descritas en este README corresponden al proyecto original; la demo pública no debe confundirse con una demostración de llamadas reales.

**De una llamada ciudadana a una respuesta coordinada. Voz, decisiones y recursos en un mismo sistema.**

Un centro de coordinación de emergencias que **recibe avisos, interpreta necesidades, localiza incidentes, asigna medios y coordina llamadas a los equipos**. Después incorpora sus respuestas, actualiza las misiones y vuelve a planificar cuando cambia la situación.

Construido para **HackSpain 2026**, combina agentes de voz de [HappyRobot](https://happyrobot.ai), un orquestador propio en **FastAPI**, persistencia en **PostgreSQL** y un puesto de mando en **Angular**. La recepción ciudadana también contempla emergencias sanitarias, rescates, tráfico y seguridad.

> [!NOTE]
> **No es solo un chatbot que recomienda qué hacer.** El proyecto conecta percepción, decisión, comunicación y seguimiento: las órdenes quedan registradas, las respuestas se contrastan con el estado y las decisiones pueden revisarse desde el puesto de mando.

```text
Escuchar → Entender → Localizar → Priorizar → Asignar → Comunicar → Verificar
                         ▲                                            │
                         └────────── Replanificar con nuevos datos ───┘
```

## El problema: coordinar, no solo conversar

Durante una crisis, la información llega fragmentada: una llamada de un vecino, una carretera cortada, un cambio de viento, una ambulancia que no responde. El reto no es únicamente entender cada mensaje, sino decidir **qué cambia, quién debe actuar y qué recursos siguen realmente disponibles**.

Este proyecto convierte esa información en un estado operativo compartido. El agente trabaja sobre él, los equipos aportan nuevos hechos y el operador puede intervenir sin convertirse en el paso obligatorio de cada decisión.

## Lo que lo hace diferente

### 1. Una llamada puede activar varios servicios, cada uno por un motivo

El ciudadano habla con un agente de voz mediante **Web Call**. HappyRobot envía un parte estructurado al backend con el tipo de emergencia, gravedad, víctimas, riesgos y ubicación. El sistema traduce ese parte en necesidades concretas, no en una única etiqueta genérica.

Por ejemplo, un **incendio grave con personas atrapadas** puede generar:

| Servicio   | Misión                              | Motivo                                                |
| ---------- | ----------------------------------- | ----------------------------------------------------- |
| Bomberos   | Extinción y rescate                 | Incendio y personas atrapadas.                        |
| Sanitarios | Asistencia y soporte al rescate     | Víctimas o riesgo vital comunicado.                   |
| Policía    | Control del perímetro y los accesos | Gravedad del incendio y seguridad de la intervención. |

Hay **una misión idempotente por servicio y aviso**: un reintento del mismo informe no multiplica las intervenciones. Los servicios se seleccionan según los hechos, no se mandan todos indiscriminadamente. Si falta una ambulancia, eso no bloquea por sí solo a los bomberos disponibles.

Además de los avisos ciudadanos, el planificador del escenario propone extinción, evacuaciones, avisos a población, comunicaciones con autoridades, apertura de albergues y actuaciones sobre carreteras.

### 2. Los recursos van a la prioridad más alta, no al aviso que llegó primero

El agente compara las necesidades con los medios compatibles antes de reservarlos. Cada misión tiene una **prioridad de 0 a 100 y un motivo explícito**: gravedad del aviso, heridos, población expuesta o tiempo estimado de llegada del frente, según el tipo de propuesta.

Cuando los medios no alcanzan, el sistema distingue situaciones que una simple cola de tareas no resolvería:

| Situación                                                  | Respuesta del sistema                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Hay medios suficientes                                     | Asigna recursos compatibles y prepara las comunicaciones.                                   |
| Dos misiones compiten con distinta prioridad               | La de mayor prioridad obtiene el recurso; puede reasignarlo desde una misión menos urgente. |
| Las prioridades más altas empatan y no alcanzan los medios | Pide una elección al operador mediante una pregunta persistente.                            |
| No existe una unidad compatible disponible ni reasignable  | Mantiene la necesidad visible y espera refuerzos o un parte de disponibilidad.              |
| Llegan refuerzos o cambia la prioridad                     | Recalcula el reparto y revisa los conflictos pendientes.                                    |

La reasignación puede afectar a una unidad ya movilizada, pero **preparar una redirección no equivale a que el equipo la haya aceptado**: se cancela la orden anterior, se prepara una nueva comunicación y se espera una respuesta nueva. Un callback antiguo no puede mover la misión replanificada.

> [!IMPORTANT]
> **La autonomía no se detiene por la gravedad.** Los avisos vitales y las evacuaciones también pueden despacharse automáticamente. La elección humana entra cuando hay un empate de máxima prioridad que no puede atenderse con los medios existentes, o cuando se activa expresamente el modo manual. Las preguntas de reparto no caducan ni deciden por silencio.

### 3. Autonomía con margen de intervención

El agente **decide, localiza, reserva y despacha** sin pedir permiso para cada paso. El operador conserva controles concretos:

- **Ventana de retención configurable:** las órdenes autónomas esperan 10 segundos por defecto antes de salir, con opción de anularlas.
- **Parada de emergencia:** frena los envíos nuevos, incluidos los retenidos, sin fingir que las comunicaciones ya enviadas han desaparecido.
- **Modo manual:** desactivar la autonomía revalida las órdenes aún no enviadas y devuelve las decisiones a confirmación humana.
- **Corrección de ubicación:** permite rectificar un aviso incluso con una misión en curso; invalida las órdenes afectadas y vuelve a proponer contra el destino corregido.
- **Intervenciones revalidadas:** las respuestas y controles comprueban el estado actual para no aplicar una decisión tomada sobre información obsoleta.

Las preguntas, respuestas y notas viven en el backend —y se conservan con PostgreSQL—, no en una pestaña del navegador.

### 4. El LLM aporta criterio; el código conserva el control

La planificación combina una **base heurística determinista** con una revisión LLM opcional. El modelo puede filtrar ruido, ajustar prioridades, explicar decisiones, descartar propuestas y sugerir un recurso.

**No envía órdenes ni escribe asignaciones directamente.** El backend vuelve a comprobar compatibilidad, contacto, reservas, disponibilidad y acceso antes de actuar. Si durante la revisión llega información que invalida el plan, no se ejecuta sin revalidarlo.

Si no hay clave del proveedor o la revisión falla, el sistema continúa con su planificador heurístico. La demo de coordinación no depende de contratar un LLM; la conversación de voz real sí requiere HappyRobot.

### 5. Localiza sin convertir la incertidumbre en una coordenada inventada

Cuando un aviso no incluye coordenadas utilizables, el agente puede buscar su dirección automáticamente. La búsqueda se hace **fuera del webhook de recepción**, para que el workflow que atiende al ciudadano no tenga que esperar al geocodificador.

- Un candidato único y suficientemente concreto puede seleccionarse como **ubicación aproximada**.
- Los resultados ambiguos y los centros genéricos de población no se eligen automáticamente.
- Sin ubicación utilizable, la propuesta permanece **bloqueada y visible**: no se descarta el aviso ni se despacha a un punto ficticio.
- Una respuesta tardía del proveedor no sobrescribe una corrección posterior.
- El proveedor se consulta con cola compartida en el runtime, caché acotada, búsquedas limitadas a España y al menos **1,1 segundos entre inicios de petición**.

No se deducen coordenadas a partir del número de teléfono. El dashboard distingue una ubicación declarada, una corrección del operador y una aproximación geocodificada.

### 6. Distingue lo solicitado, lo confirmado y lo estimado

Una de las decisiones de diseño más importantes es **no confundir el éxito de una comunicación con el éxito de una intervención**.

| Hecho                               | Lo que significa —y lo que no—                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Se ha enviado una orden             | La comunicación ha salido. Todavía no demuestra que la unidad esté en camino.                   |
| La unidad acepta la llamada         | Puede comenzar el seguimiento del desplazamiento hacia la misión.                               |
| El marcador avanza                  | Es una estimación temporal identificada como tal, no GPS ni tráfico en directo.                 |
| Llega un parte con ubicación        | La posición reportada prevalece sobre la estimación.                                            |
| La unidad llega al destino          | Pasa a estar en el lugar; el tiempo transcurrido no cierra la misión.                           |
| Se cancela una misión ya comunicada | La unidad no queda libre automáticamente: hace falta un parte de disponibilidad correlacionado. |
| Se dispara un aviso de Telegram     | Queda pendiente del resultado del workflow; no se da por entregado solo por haberlo enviado.    |

Esta separación permite mostrar no solo **qué quiere hacer el agente**, sino **qué evidencia existe de que esté ocurriendo**.

### 7. Persistencia y comunicaciones diseñadas para manejar fallos

El backend es dueño del estado consolidado. Los agentes externos aportan **observaciones**, y el sistema las valida, aplica o descarta dejando un recibo. Con PostgreSQL, esa disciplina se extiende a las decisiones y los envíos:

- **Guardado atómico:** snapshot, recibos, asignaciones, órdenes y journal se confirman conjuntamente.
- **Concurrencia optimista:** cada escritura exige la versión esperada; un conflicto no se publica como si hubiese tenido éxito.
- **Outbox transaccional:** la intención de enviar se guarda antes de contactar con HappyRobot y se reclama y revalida antes de ejecutarla.
- **Idempotencia y datos atrasados:** los reintentos no deben duplicar efectos; los informes antiguos no sustituyen sin más a hechos más recientes.
- **Incertidumbre explícita:** si un timeout deja dudas sobre si una orden llegó a salir, queda `unknown`; no se reenvía a ciegas.
- **Recuperación tras reinicios:** se restauran misiones, órdenes, asignaciones y preguntas pendientes.
- **Fallo conservador:** si la persistencia deja de ser fiable, se bloquea el despacho en lugar de actuar sobre un estado no confirmado.

No se promete entrega «exactamente una vez» a un servicio externo. Se registran los estados inciertos y se ofrece reconciliación, una distinción importante cuando repetir una llamada también tiene consecuencias.

### 8. Un puesto de mando compartido y en vivo

El dashboard usa **Angular 22, signals, componentes standalone, Leaflet y Tailwind CSS**. Inicio, Incidencias, Recursos y el registro de operaciones se alimentan de una misma fuente API + **Server-Sent Events (SSE)**.

| Vista                       | Qué permite entender                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inicio**                  | Situación general, mapa, decisiones automáticas, retenciones y controles del agente.                                                                          |
| **Incidencias**             | Avisos, ubicación, necesidades y unidades relacionadas con cada intervención.                                                                                 |
| **Recursos**                | Estado, capacidad, contacto, asignación actual e historial de intervenciones.                                                                                 |
| **Registro de operaciones** | Eventos, preguntas de coordinación, respuestas, notas y comunicaciones, con errores, transcripciones e identificadores de ejecución cuando están disponibles. |

Si se pierde la conexión, conserva el último snapshot y muestra el problema; no lo sustituye por datos de ejemplo. Mientras SSE no está disponible, intenta recuperar el estado por HTTP.

El mapa reutiliza las rutas descargadas e interpola el movimiento con la salida y duración proporcionadas por el backend. **La animación nunca decide que una unidad ha llegado.** Las misiones de avisos ciudadanos no solicitan rutas al proveedor público: muestran la posición estimada del backend.

### 9. Una crisis que se puede simular, no solo una pantalla que se puede enseñar

El repositorio incluye un simulador que introduce eventos según las fases de una crisis: **ignición, escalada, complicaciones y resolución**. Genera cambios de viento, cortes de carretera, heridos, incidencias de recursos y ruido informativo; también simula respuestas a llamadas, incluidos rechazos y falta de respuesta.

La semilla aleatoria es configurable para repetir escenarios de prueba. El cliente HappyRobot simulado permite preparar órdenes sin llamar a nadie; **los resultados los aporta el simulador o un callback explícito**, no una aceptación inventada por el backend.

La API cuenta con **más de cien pruebas** sobre el flujo, la asignación, la geocodificación, el movimiento, los fallos y la persistencia. Las pruebas aíslan la configuración local y bloquean el transporte HTTP externo. La CI del backend ejecuta también las pruebas SQL contra PostgreSQL real, con un esquema temporal por test.


## Demo local sin llamadas reales

### Requisitos

- **Python 3.12 o superior** y **uv**.
- **Node.js compatible con Angular 22**: `^22.22.3 || ^24.15.0 || >=26.0.0`. En el proyecto se ha verificado Node `24.20.0`.
- **npm 11.19.0**, versión declarada por el dashboard.
- Docker solo si quieres usar PostgreSQL; el arranque siguiente usa memoria.

Los comandos parten de la raíz del repositorio, en terminales separadas. No hace falta copiar ni sobrescribir ningún `.env`.

> [!IMPORTANT]
> Este arranque fuerza las comunicaciones simuladas, desactiva la revisión LLM y la geocodificación remotas y deja el bucle de planificación sin autoarranque hasta que lo actives. Las claves de ejemplo son **solo para desarrollo local**. El mapa del navegador puede seguir consultando teselas y rutas públicas: no es una demo completamente offline.

### 1. Arrancar la API

```bash
cd apps/api
uv sync --frozen

export STORAGE_BACKEND=memory HAPPYROBOT_MODE=simulated
export AGENT_AUTOSTART=false AGENT_AUTONOMOUS=true SEED_DEMO=true
export OPENAI_API_KEY= GEOCODING_ENABLED=false SEED_PHONES=
export API_KEY=dev-secret HAPPYROBOT_WEBHOOK_SECRET=demo-webhook-only
export PUBLIC_BASE_URL=http://127.0.0.1:8000

uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- OpenAPI: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).
- Salud y modo efectivo: [http://127.0.0.1:8000/healthz](http://127.0.0.1:8000/healthz).
- Con `memory`, reiniciar o recargar el proceso pierde el estado de esa demo.

### 2. Abrir el puesto de mando

```bash
cd dashboard
npm ci
API_KEY=dev-secret API_PROXY_TARGET=http://127.0.0.1:8000 npm start -- --host 127.0.0.1
```

Abre [http://localhost:4200](http://localhost:4200). El proxy de desarrollo inyecta la clave de operador sin incluirla en el bundle del navegador. Aquí se fija explícitamente el destino `8000`, porque el proxy del proyecto usa `8001` por defecto.

### 3. Activar el agente e introducir eventos

Primero comprueba que `/healthz` indica `happyrobot_mode: simulated`. Después activa el bucle con el endpoint que **rechaza el modo live**:

```bash
curl -X POST http://127.0.0.1:8000/api/v1/control/resume-simulated \
  -H 'X-API-Key: dev-secret'
```

En esa misma terminal, desde la raíz del repositorio:

```bash
cd apps/simulator
uv sync --frozen
API_KEY=dev-secret HAPPYROBOT_WEBHOOK_SECRET=demo-webhook-only \
  uv run python simulator.py --api-url http://127.0.0.1:8000/api/v1 \
  --seed 7 --no-reset --no-approve
```

`--no-reset` conserva el escenario que ya está abierto y `--no-approve` evita que un operador simulado conteste aprobaciones. Verás eventos, decisiones y respuestas de comunicaciones sin realizar llamadas reales. Detener el simulador no pausa el agente; usa la parada del dashboard cuando quieras frenar nuevos envíos.

> [!TIP]
> Para enseñar el criterio del sistema, deja visible el registro junto al mapa. Es más interesante observar **por qué se asigna una unidad y qué ocurre si no responde** que limitarse a ver un marcador moverse. Puedes ajustar la cadencia con `--min-delay` y `--max-delay`.

### Conservar el estado con PostgreSQL

El [Compose de desarrollo](apps/api/compose.yaml) proporciona PostgreSQL en `127.0.0.1:55433` con volumen persistente. Sigue la [guía de la API](apps/api/README.md#postgresql-persistencia-duradera) para configurar `STORAGE_BACKEND=postgres` y `DATABASE_URL`.

Sobre una base vacía, el arranque crea el esquema v1. Si encuentra un esquema parcial o incompatible, se detiene sin modificarlo. La persistencia no necesita credenciales de HappyRobot.

La configuración se resuelve en este orden: **entorno del proceso → `.env.local` → `.env` → valores por defecto**. Los cambios de entorno requieren reiniciar; la política de autonomía de un incidente ya guardado se conserva en su snapshot.

## Verificación

### Backend

Desde `apps/api`, con sus dependencias instaladas:

```bash
export HAPPYROBOT_MODE=simulated AGENT_AUTOSTART=false OPENAI_API_KEY=
uv run ruff check .
uv run ruff format --check .
uv run mypy app
uv run pytest -q
```

Las pruebas cubren, entre otros casos, avisos duplicados y atrasados, prioridades en competencia, reasignación de unidades movilizadas, respuestas obsoletas, parada de emergencia, ubicaciones ambiguas, timeouts de envío y recuperación tras reinicios.

Para incluir las pruebas SQL, configura `TEST_POSTGRES_DSN` contra una base **de desarrollo** siguiendo la [guía de pruebas](apps/api/README.md#pruebas-y-calidad). Cada prueba usa su propio esquema temporal. Sin esa variable, los casos que requieren PostgreSQL se omiten; la CI de la API sí dispone de ese servicio.

### Dashboard

Desde `dashboard`, con Node y npm compatibles:

```bash
npm run build
npm test -- --watch=false
```

La suite de Vitest incluye estado y transporte, geocodificación, rutas, mapa y vistas operativas. Consulta las [notas del dashboard](dashboard/AGENTS.md) para los requisitos de almacenamiento web en Node y las incidencias de pruebas conocidas.

## Alcance y precauciones

> [!WARNING]
> **`HAPPYROBOT_MODE=live` puede generar llamadas y mensajes reales.** Las llamadas usan los teléfonos configurados para los contactos; no basta con que el proyecto se llame «demo». Revisa modo, destinatarios, workflows y entorno publicado antes de activarlo. Pausar bloquea envíos nuevos, pero no cancela comunicaciones ya enviadas ni libera unidades movilizadas.

> [!CAUTION]
> **La geocodificación pública no es un entorno privado.** Cuando está habilitada, la configuración predeterminada del backend envía las direcciones de los avisos —también las privadas— al Nominatim público. Para trabajar con datos sensibles o fuera de la demo, configura una instancia propia o un proveedor adecuado. Aplica la misma revisión a mapas y rutas, y no publiques secretos, teléfonos reales ni URLs privadas de callbacks.

Otros límites importantes de esta versión:

- **Prototipo, no infraestructura de emergencias:** no sustituye protocolos oficiales, validación operativa ni sistemas de despacho certificados.
- **Geografía aproximada:** ni el movimiento representa GPS, ni las rutas reflejan tráfico en directo, ni la heurística garantiza una asignación óptima de toda la flota.
- **Despliegue acotado:** está previsto un proceso activo por incidente. El control de versiones protege escrituras concurrentes, pero no hay elección de líder distribuida.
- **Autenticación de desarrollo:** el proxy local no sustituye una sesión de usuario y una política de permisos para un despliegue público.
- **Servicios externos configurables:** la voz real, Telegram y la revisión LLM requieren sus respectivas configuraciones. El workflow de Telegram documentado usa un chat de destino único; no implica un directorio completo de chats por contacto.

## Más documentación

- [API: arranque, PostgreSQL, migración, comunicaciones y pruebas](apps/api/README.md).
- [Arquitectura de persistencia, contrato de observaciones y outbox](docs/architecture.md).
- [Simulador: fases, parámetros y respuestas](apps/simulator/README.md).
- [Dashboard: convenciones, entorno y verificación](dashboard/AGENTS.md).

Algunas secciones históricas de la documentación técnica todavía describen aprobación por gravedad. **La política actual es asignación autónoma por prioridad, con elección humana en empates por escasez o en modo manual**, implementada en [autonomía](apps/api/app/domain/autonomy.py) y [asignación](apps/api/app/agent/allocation.py).

---

**Lo más potente no es que la IA hable: es que esa conversación se convierta en decisiones coordinadas, verificables y revisables cuando la realidad cambia.**
