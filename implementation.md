# Implementação proposta

## Objetivo

Criar uma biblioteca de circuit breaker especializada em Axios, com decorators para configurar o breaker e registrar handlers de eventos. O método decorado deve executar uma chamada Axios. A especialização deve aparecer na API pública por meio de tipos Axios, classificação de erros Axios e preservação do resultado original da requisição; não é apenas um wrapper genérico para qualquer `Promise`.

```ts
class UserService {
  @HttpCircuitBreaker({
    options: { resetTimeout: 5_000 },
    circuitGroup: "users",
  })
  getUser(id: string): Promise<AxiosResponse<User>> {
    return axios.get(`/users/${id}`);
  }

  @onHttpCircuitOpen({ circuitGroup: "users" })
  onUsersCircuitOpen(event: CircuitOpenEvent) {
    // Registrar métrica, alerta, log etc.
  }
}
```

O decorator não deve alterar uma resposta bem-sucedida: se o método retorna `AxiosResponse<T>`, esse é o valor retornado; se o método retorna `response.data`, esse valor é preservado. Em caso de rejeição, o erro original do Axios também deve ser propagado sem perder `response`, `request`, `config`, `code` ou `cause`.

## Nomenclatura da API — proposta

Os nomes devem comunicar que o breaker protege chamadas HTTP sem atrelar a API pública ao Axios. Proposta:

- `@HttpCircuitBreaker(...)` para decorar o método que executa a chamada HTTP.
- `@onHttpCircuitOpen(...)` e `@onHttpCircuitClosed(...)` para registrar as transições principais do breaker.
- `@onHttpCircuitFallback(...)` para registrar o fallback do breaker HTTP.
- `@onHttpCircuitEvent(...)` para registrar os demais eventos suportados.

`HttpCircuitBreaker` é a recomendação para o decorator principal: é curto e deixa claro o contexto. Usar o prefixo `HttpCircuit` nos decorators relacionados mantém a API consistente e explicita que eventos e fallback pertencem a esse mesmo tipo de breaker. `RequestCircuitBreaker` também é possível, mas “request” pode significar outros tipos de operação além de HTTP; `HttpRequestCircuitBreaker` é mais explícito, porém mais longo. Os nomes dos decorators HTTP são uma proposta aceita para a API e devem ser usados consistentemente.

## Escopo e identidade dos circuitos

Cada breaker deve pertencer a uma instância e a um método decorado:

```text
instância → método → breaker
```

Consequências:

- Instâncias diferentes da mesma classe têm breakers independentes.
- Métodos diferentes da mesma instância têm breakers independentes.
- O estado do circuito não é compartilhado implicitamente entre instâncias ou métodos.
- O `this` usado pelo método e pelos handlers corresponde à instância que está fazendo a chamada.

Internamente, o armazenamento pode ser um `WeakMap` indexado pela instância. Cada entrada guarda os breakers por `propertyKey`, por exemplo `Map<string | symbol, CircuitBreaker>`. O `WeakMap` permite que instâncias que não são mais referenciadas sejam coletadas pelo garbage collector.

O `circuitGroup` não identifica nem compartilha o estado do breaker. Ele serve somente para associar handlers de eventos e fallback aos breakers configurados com o mesmo grupo. Portanto, dois métodos no mesmo grupo continuam tendo breakers independentes, mas podem notificar os mesmos handlers.

Essa associação é local à instância: handlers registrados em outra instância ou classe não recebem eventos, mesmo que usem o mesmo nome de grupo. O grupo não é um canal global nem um mecanismo de comunicação entre classes. Essa limitação é intencional: mantém o ciclo de vida e o contexto (`this`) dos handlers junto ao serviço que executa a chamada, evita acoplamento global e impede que nomes iguais associem circuitos sem querer. Se futuramente houver necessidade de observabilidade centralizada, ela pode ser adicionada por uma integração explícita, como um event bus ou callbacks externos, sem mudar o isolamento padrão.

Não haverá grupo padrão. `circuitGroup` deve ser informado explicitamente em cada `@HttpCircuitBreaker` e decorator de handler (`@onHttpCircuitOpen`, `@onHttpCircuitClosed`, `@onHttpCircuitHalfOpen`, `@onHttpCircuitFailure`, `@onHttpCircuitFallback` e `@onHttpCircuitEvent`). Isso evita associação implícita de handlers e deixa visível no código quais breakers recebem quais eventos. O nome só organiza handlers dentro da mesma instância: não identifica o breaker, não compartilha estado e não conecta instâncias ou classes diferentes. Métodos diferentes podem declarar o mesmo grupo para compartilhar handlers, mantendo breakers independentes.

## API pública

### `HttpCircuitBreaker`

Decorator de método que:

1. Lê as opções do decorator.
2. Na primeira chamada de cada instância/método, cria e armazena o breaker.
3. Cria a ação do breaker para invocar o método original com o `this` e os argumentos daquela chamada.
4. Associa os handlers e o fallback registrados para o grupo.
5. Configura a classificação de erros própria para Axios.
6. Executa a chamada através do breaker.

As opções específicas do Opossum podem ser expostas como `options`, junto das opções próprias da biblioteca, como `circuitGroup`, `getErrorCause` e `shouldCountAsFailure`. `getErrorCause(error)` permite extrair uma causa de um erro encapsulado sem acoplar o pacote ao tipo da exceção da aplicação. O erro extraído é usado para classificação, mas a rejeição original continua sendo propagada sem alteração. Sem `getErrorCause`, o erro recebido é classificado diretamente. `shouldCountAsFailure` substitui a política de classificação padrão; quando as duas opções são fornecidas, recebe o erro extraído por `getErrorCause`. A opção `errorFilter` do Opossum não é aceita dentro de `options`, pois tem semântica inversa e conflitante. Um erro filtrado continua rejeitando a chamada, mas o Opossum o contabiliza como sucesso em suas estatísticas. O timeout do Opossum fica desativado por padrão (`timeout: false`) para não competir implicitamente com timeouts e deadlines propagados pela aplicação; o consumidor pode habilitá-lo explicitamente com um valor numérico em `options.timeout`. Esse timeout adicional não garante o cancelamento da operação Axios já iniciada. Os valores padrão devem ser documentados e mantidos em um único lugar.

Como a biblioteca é especializada em Axios, a assinatura pública deve usar tipos Axios onde forem relevantes, especialmente para erros, respostas e fallback. O tipo do retorno do método decorado deve ser preservado pelo decorator.

### Decorators de eventos

`@onHttpCircuitOpen`, `@onHttpCircuitClosed`, `@onHttpCircuitHalfOpen` e `@onHttpCircuitFailure` registram handlers para os eventos mais usados. Os nomes públicos `Open`, `Closed` e `HalfOpen` representam as transições homônimas do Opossum; `Failure` representa a falha individual da ação. O evento `halfOpen` sinaliza que o tempo de reset terminou e uma chamada de teste poderá passar.

`@onHttpCircuitEvent` registra handlers para os demais eventos suportados: `success`, `timeout`, `reject`, `fire`, `cacheHit`, `cacheMiss`, `semaphoreLocked`, `healthCheckFailed` e `shutdown`. Os eventos `open`, `close`, `halfOpen`, `failure` e `fallback` são excluídos desse decorator para evitar duas formas concorrentes de registrar os eventos com decorators próprios ou comportamento específico; `fallback` é executado por `@onHttpCircuitFallback`.

Esses decorators registram metadados. O handler é um método da própria classe (ou da cadeia de protótipos) e pode receber o payload daquele evento. Ao criar o breaker para uma instância, a biblioteca resolve esse método nessa instância e o vincula ao `this` correspondente. Portanto, o isolamento por instância não impede receber eventos: cada instância recebe eventos do seu próprio breaker, sem compartilhar estado nem callbacks vinculados a outro objeto.

Exemplo: um handler de `failure` pode receber o erro Axios e inspecionar `response`, `status` ou `config`. Já `open` representa uma mudança de estado do circuito e, conforme o contrato do evento do Opossum, pode não trazer o erro que levou à abertura. Para observar a falha individual, use `failure`; para saber quando o circuito abriu, use `open`. Se a API quiser incluir a causa no evento `open`, isso deve ser uma conveniência explícita da biblioteca, com comportamento definido para falhas concorrentes, e não uma suposição sobre o payload do Opossum.

Esse modelo é voltado a handlers declarados na classe e na instância que executa o método decorado. Um mecanismo de inscrição externo à classe, como `breaker.on(...)` ou um callback global, não faz parte do MVP e poderia ser considerado separadamente se houver essa necessidade.

### Fallback

O fallback será registrado por `@onHttpCircuitFallback`, associado a um `circuitGroup` obrigatório. Ele não será registrado novamente por `@onHttpCircuitEvent`. Deve ser opcional. Sem fallback, a rejeição original do breaker deve ser propagada.

O contrato é `{ input, err }`, onde `input` é a tupla de argumentos passados ao método e `err` preserva o erro original, incluindo tipo e dados de `AxiosError` quando aplicável. O valor retornado pelo fallback deve ser compatível com o tipo de retorno do método decorado. O Opossum executa fallback para falhas contabilizadas e chamadas rejeitadas por circuito aberto; um erro filtrado pela política de contagem não dispara fallback. Sem fallback, não se deve transformar uma falha em resposta bem-sucedida.

## Fluxo de execução

Em termos conceituais, a chamada decorada segue este fluxo:

```ts
async function decoratedMethod(this: object, ...args: unknown[]) {
  const breaker = getOrCreateBreaker(this, propertyKey, () =>
    createBreaker(
      (...currentArgs: unknown[]) =>
        originalMethod.apply(this, currentArgs),
      {
        ...options,
        errorFilter: (error) => !shouldCountAxiosError(error),
      },
    ),
  );

  return breaker.fire(...args);
}
```

O armazenamento e a criação reais devem garantir que o breaker seja criado uma única vez para cada instância/método. A ação deve ser construída no contexto correto e não pode ser reaproveitada por outra instância.

## Organização sugerida

```text
src/
  circuit-breaker.ts  # Decorator principal e execução
  metadata.ts         # Registro de grupos, eventos e fallback
  index.ts            # Exports públicos
```

Manter a implementação pequena no início. Um módulo separado para tipos só é necessário se os tipos públicos crescerem o suficiente para justificar essa divisão.

## Dependências e configuração

Opossum será o motor interno e `opossum` será uma dependência de runtime do pacote. As opções de configuração do breaker serão compatíveis com as opções do Opossum, documentando essa relação para que os consumidores possam usar recursos suportados pelo motor. A API pública deve evitar expor tipos internos desnecessários quando isso não trouxer valor.

Como a biblioteca é especializada em Axios e usa suas APIs para reconhecer cancelamentos e erros, `axios` deve ser declarado como `peerDependency` compatível, para que o consumidor controle a versão usada pela aplicação; também deve estar como `devDependency` para testes e build locais. Como os tipos de Opossum fazem parte do tipo público das opções, `@types/opossum` deve estar disponível aos consumidores TypeScript.

O projeto usa TypeScript strict e decorators padrão, sem habilitar `experimentalDecorators`. A implementação e os testes devem continuar usando a assinatura padrão (método e contexto), sem misturar a assinatura legada. A documentação para usuários deverá informar a versão mínima de TypeScript depois de validada para a API completa.

## Eventos e tipos

Os nomes dos eventos e os parâmetros recebidos pelos handlers devem refletir o comportamento real do Opossum. Eventos diferentes podem fornecer argumentos diferentes; por isso, os tipos devem ser associados a cada evento sempre que possível, em vez de tratar todos como se recebessem o mesmo objeto. Quando um evento incluir um erro de requisição, o tipo deve preservar os dados Axios disponíveis.

Em particular, não se deve prometer que `open` recebe o erro causador da abertura. O handler de `failure` é o ponto para observar falhas individuais; `open` sinaliza a transição de estado. Os decorators devem permitir registrar ambos separadamente.

### Payload dos handlers — decidido

Os métodos decorados com `@onHttpCircuitEvent`, `@onHttpCircuitOpen`, `@onHttpCircuitClosed`, `@onHttpCircuitHalfOpen` ou `@onHttpCircuitFailure` recebem um objeto de evento definido pela própria biblioteca, com formato tipado por evento. Isso evita expor diretamente os argumentos internos do Opossum e mantém o erro Axios original acessível no payload.

```ts
@onHttpCircuitFailure({ circuitGroup: "users" })
onFailure(event: CircuitFailureEvent) {
  // event.error mantém a referência ao erro original;
  // event.latencyMs e event.args são campos explícitos.
}

@onHttpCircuitOpen({ circuitGroup: "users" })
onOpen(event: CircuitOpenEvent) {}
```

O objeto deve conter somente os dados relevantes e documentados daquele evento. Por exemplo, `failure` inclui o erro original, a latência e os argumentos da chamada; `open` sinaliza a transição de estado e não deve fingir que recebeu o erro que a causou. Os tipos de payload são parte da API pública e devem permanecer estáveis mesmo que o motor interno mude.

### Tipagem dos dados Axios nos eventos — decidido

Os payloads de eventos que carregam resultado ou erro aceitam tipos genéricos opcionais, com `unknown` como padrão. O consumidor pode informar o formato conhecido sem conversão ou cast em cada uso:

```ts
type ApiProblem = { code: string; message: string };

onFailure(event: CircuitFailureEvent<ApiProblem>) {
  event.axiosError?.response?.data.code;
}
```

O tipo genérico só descreve o formato esperado em tempo de compilação; não valida nem transforma a resposta recebida. A API preserva o erro original como `unknown` e expõe separadamente um campo opcional tipado, como `axiosError?: AxiosError<TData>`, porque a operação ainda pode rejeitar com um erro que não seja do Axios. Não usar `any` como padrão: `unknown` exige que o consumidor verifique dados não tipados antes de acessá-los. Para eventos de sucesso, um tipo genérico equivalente pode descrever o resultado original do método, sem obrigar eventos de estado (`open`, `close`, `halfOpen`) a carregar dados da resposta.

O genérico é opcional: não exige mapear nem converter respostas. Ele é uma declaração de tipo feita pelo consumidor; não representa validação em runtime. Como handlers podem ser associados por grupo a métodos diferentes, possivelmente com formatos de resposta distintos, a tipagem genérica é declarada pelo consumidor e não deve ser apresentada como inferência automática do grupo. Se um handler receber respostas de vários métodos, o consumidor pode usar uma união dos formatos conhecidos ou deixar o tipo como `unknown`. A escolha de incluir o resultado completo em eventos de sucesso continua sujeita a uma decisão de API, considerando privacidade e tamanho de payloads.

## Tratamento de erros

O breaker deve preservar a semântica de Promise: sucesso retorna o resultado original do método; falha rejeita com o erro original, a menos que um fallback configurado produza um valor. Não deve descartar ou embrulhar um `AxiosError` de forma que impeça o consumidor de inspecionar `response`, `request`, `config`, `code` ou `cause`.

### Política padrão de contagem

A política deve ser configurável por `shouldCountAsFailure(error)`. Uma proposta de padrão para uma biblioteca Axios-aware:

- Erros de cancelamento do Axios não contam como falha do serviço.
- Erros de rede e timeouts do cliente contam, mesmo quando não há resposta HTTP.
- Respostas `408 Request Timeout`, `429 Too Many Requests` e `5xx` contam como falhas. `408` e `429` são exceções aos demais `4xx`: podem indicar timeout ou sobrecarga transitória no serviço ou em um intermediário.
- Outros erros Axios com resposta `4xx` não contam por padrão, pois normalmente representam uma resposta válida do serviço a uma solicitação inválida, não autorizada ou inexistente.
- Erros que não sejam Axios contam, para que falhas inesperadas no método não sejam silenciosamente ignoradas.

Essa política deve ser documentada como padrão, não como regra universal: a classificação correta depende do serviço e do tipo de operação. `getErrorCause` adapta erros encapsulados à política padrão sem substituí-los; `shouldCountAsFailure` permite substituir a política. O breaker observa falhas ao longo de uma janela e aplica o limiar configurado, então uma falha isolada não deve abrir o circuito por si só. A implementação deve converter o resultado do classificador para a convenção inversa do `errorFilter` do Opossum sem alterar o erro que a chamada rejeita. A política também deve respeitar configurações Axios como `validateStatus`: respostas que o Axios considera sucesso continuam sendo sucesso para o breaker.

O Opossum não interpreta códigos HTTP: ele observa se a ação assíncrona resolveu ou rejeitou e, opcionalmente, filtra erros. Por isso, o decorator não precisa de um `mapStatus` próprio no MVP. Para definir quais status HTTP o Axios trata como sucesso ou rejeição, o consumidor pode configurar `validateStatus`; `shouldCountAsFailure` decide quais rejeições contam para abrir o circuito. Status de negócio dentro do corpo de uma resposta bem-sucedida não devem afetar o breaker por padrão. Se houver um caso de uso concreto para isso, uma opção futura poderia classificar respostas com um predicado explícito, em vez de introduzir um mapeamento genérico de status no decorator base.

### Interação com retry do Axios

O circuit breaker não depende de `axios-retry` e não deve instalar nem configurar retry por conta própria. Consumidores sem retry podem usar o decorator normalmente: cada chamada do método protegido executa a ação uma vez. Se o método usa uma instância Axios com um interceptor de retry, o breaker observa o resultado final da Promise do método, não cada tentativa HTTP.

Isso tem algumas consequências para a integração:

- Um erro transitório que o Axios recupera não chega ao breaker. A chamada conta como sucesso quando uma tentativa posterior resolve.
- Se todas as tentativas falharem, o breaker conta uma falha lógica, não uma falha por tentativa. Portanto, retry pode atrasar a abertura do circuito, e `volumeThreshold` representa chamadas do método, não requisições HTTP individuais.
- Tentativas adicionais aumentam a latência e a carga durante uma indisponibilidade. Considere conjuntamente o número de retries, o orçamento/deadline da requisição e `options.timeout` do Opossum. Um timeout do breaker menor que o tempo total permitido para retries pode fazer o breaker rejeitar antes de a operação Axios terminar; o timeout do breaker não deve ser tratado como cancelamento garantido da requisição em andamento.
- O decorator classifica o erro que a Promise protegida rejeita. Se uma camada HTTP converter `AxiosError` em uma exceção própria, a política Axios padrão não consegue mais identificar status ou cancelamento pelo tipo externo. Quando a exceção mantém o erro Axios original como causa, `getErrorCause` pode extraí-lo para reutilizar a política padrão do breaker, sem acoplamento com o tipo da exceção e sem alterar o erro propagado. Se também for fornecido `shouldCountAsFailure`, ele recebe a causa extraída e substitui a política padrão.
- Retry só ocorre se a aplicação configurar o interceptor correspondente na instância Axios e a chamada solicitar retry. A biblioteca do breaker não deve presumir esse interceptor nem depender de metadados específicos como `axios-retry`.

Retry só ocorre se a aplicação configurar uma estratégia ou interceptor correspondente na instância Axios. Limites, orçamento de retry e propagação de deadline são responsabilidade do consumidor e não são configurados pelo circuit breaker. Se forem necessárias políticas diferentes para erros individuais e resultado final, elas devem ser implementadas explicitamente na camada de retry ou em uma integração futura; o decorator base observa somente a rejeição final.

## Testes necessários

Os testes devem verificar comportamento, não apenas tipos:

1. Chamadas bem-sucedidas retornam o mesmo tipo e valor original (`AxiosResponse<T>` ou `data`, conforme o método).
2. Rejeições Axios são propagadas sem perda de campos nem alteração de identidade do erro.
3. Duas instâncias da mesma classe mantêm estados independentes.
4. Dois métodos na mesma instância têm breakers independentes.
5. Handlers de eventos são chamados com o `this` da instância correta.
6. Métodos com o mesmo grupo compartilham handlers, mas não estado do circuito.
7. Grupos diferentes recebem somente seus respectivos handlers.
8. Fallback recebe os dados de erro Axios disponíveis e retorna valor compatível com o tipo do método; sem fallback, a falha continua sendo rejeitada.
9. A política padrão ignora cancelamentos e os `4xx` exceto `408` e `429`; conta erros de rede/timeout e respostas `408`, `429` e `5xx`; e trata erros não Axios conforme a regra documentada.
10. `shouldCountAsFailure` permite personalizar a classificação e `validateStatus` é respeitado.
11. Os padrões e opções customizadas são aplicados corretamente.
12. Quando usado com retry externo, o breaker conta a resolução/rejeição final da operação, e não cada tentativa interna; exceções próprias que encapsulam `AxiosError` podem usar `getErrorCause` para extrair a causa sem perder a identidade da rejeição original.

Usar tempos curtos ou relógios falsos nos testes de timeout/reset, para evitar testes lentos e instáveis.

## Critérios para o MVP

- Decorator de método com opções do breaker.
- Tipos Axios preservados para retorno, erro e fallback.
- Política padrão de contagem de erros Axios, com opção para customização.
- Identidade do circuito por instância e método.
- Registro de handlers por grupo.
- Fallback opcional, se sua API e tipagem puderem ser definidas sem ambiguidade.
- Tipos públicos e exports explícitos.
- Testes cobrindo isolamento, execução, eventos e erros.
- README atualizado com instalação, configuração e semântica de `circuitGroup`.

Não incluir compartilhamento global entre instâncias no MVP. Se surgir um caso de uso concreto, pode ser adicionado depois como funcionalidade explícita, sem alterar o isolamento padrão.

## Fases de implementação

O trabalho será dividido em três fases, cada uma com um resultado verificável para facilitar o acompanhamento.

### Fase 1 — Núcleo do breaker HTTP

**Status: concluída.**

- Adicionar Opossum como dependência de runtime e Axios como `peerDependency` (e dependência de desenvolvimento para testes).
- Disponibilizar os tipos de Opossum às aplicações TypeScript que consomem as opções públicas.
- Implementar `@HttpCircuitBreaker` com decorators padrão do TypeScript e `circuitGroup` obrigatório.
- Criar breakers isolados por instância e método; não compartilhar estado entre instâncias.
- Preservar valores de sucesso e propagar o erro original.
- Implementar a política padrão de classificação Axios e a opção `shouldCountAsFailure`.
- Usar os padrões do exemplo existente: `errorThresholdPercentage: 20`, `volumeThreshold: 5`, `rollingCountTimeout: 5_000`, `resetTimeout: 2_500` e `allowWarmUp: true`.
- Testar execução, classificação de erros e isolamento dos circuitos.

**Checkpoint concluído:** API principal compilando; testes do núcleo passando; build produzindo ESM, CommonJS e declarações.

### Fase 2 — Eventos e fallback

- **Status: concluída.**
- Implementar `@onHttpCircuitOpen` e `@onHttpCircuitClosed`.
- Implementar decorators dedicados para `open`, `close`, `halfOpen` e `failure`.
- Implementar `@onHttpCircuitEvent` para os demais eventos Opossum, excluindo eventos com decorators próprios e `fallback`.
- Implementar `@onHttpCircuitFallback` com payload `{ input, err }`.
- Definir payloads próprios por evento e manter o erro Axios original acessível.
- Associar handlers e fallback por grupo somente dentro da mesma instância.
- Cobrir payloads, associação de grupos, binding de `this`, transições e fallback com testes.

**Checkpoint concluído:** decorators de eventos e fallback exportados, documentados por tipos e cobertos por testes.

### Fase 3 — API pública e validação final

- **Status: concluída.**
- Exportar os decorators e tipos públicos pelo `src/index.ts`.
- Atualizar o README com configuração, semântica de grupos, erros encapsulados, eventos e fallback.
- Confirmar os metadados de dependências e compatibilidade com TypeScript/decorators padrão.
- Rodar typecheck, testes e build de publicação.

**Checkpoint concluído:** pacote construído com sucesso e instruções de uso alinhadas ao comportamento testado.

## Decisões da API

1. **Formato dos decorators — decidido:** usar decorators padrão do TypeScript, voltados a versões modernas, sem exigir `experimentalDecorators`. Validar e documentar a versão mínima necessária.
2. **Payload dos eventos — decidido:** cada handler recebe um objeto definido e tipado pela biblioteca, preservando o erro Axios original quando aplicável. Os consumidores não dependem da assinatura do Opossum.
3. **Grupo obrigatório — decidido:** não haverá grupo padrão; exigir `circuitGroup` em cada `@HttpCircuitBreaker` e decorator de handler HTTP. O grupo associa handlers apenas dentro da mesma instância e não compartilha estado.
4. **Fallback — decidido:** usar um decorator próprio `@onHttpCircuitFallback`, com `circuitGroup` obrigatório, para deixar explícito o contrato de retorno do fallback.
5. **Status HTTP padrão — decidido:** contar respostas `408 Request Timeout`, `429 Too Many Requests` e `5xx`; ignorar os demais `4xx`. Erros de rede e timeout sem resposta também contam, enquanto cancelamentos não contam. Essa é uma política padrão razoável para falhas transitórias/indisponibilidade, não uma regra universal; `shouldCountAsFailure` permite personalização.
6. **Motor do circuito — decidido:** usar Opossum internamente e expor opções compatíveis com seu contrato, documentando essa dependência.