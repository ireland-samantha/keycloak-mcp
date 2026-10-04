package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.ReadBody;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.RawHttp;
import io.github.irelandsamantha.keycloakmcp.equivalence.oracle.AdminClientOracle;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ParamSpec;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * A case request as the reference performs it: through the admin client's typed binding when the adapter has the
 * operation (with a binding that sends the case's query and body), else as raw HTTP.
 */
final class ReferenceCall {

    /** @param via the binding's Java chain, or raw HTTP */
    record Answer(int status, String via) {
    }

    private final Map<String, List<Endpoint>> bindings;
    private final AdminClientOracle adapter;
    private final RawHttp http;

    /** @param bindings admin-client endpoints by name-free operation key */
    ReferenceCall(Map<String, List<Endpoint>> bindings, AdminClientOracle adapter, RawHttp http) {
        this.bindings = bindings;
        this.adapter = adapter;
        this.http = http;
    }

    Answer perform(CaseRequest request) {
        Optional<Endpoint> binding = binding(request);
        if (binding.isEmpty()) {
            RawHttp.Response r = ServerCalls.send(http, request.method(),
                    request.args().rawPathAndQuery(request.template()), request.args().body());
            return new Answer(r.status(), "raw HTTP");
        }
        Endpoint e = binding.get();
        Object body = request.args().body() == null ? null : new ReadBody.JsonEntity(request.args().body())
                .adapterValue(e.params(ParamSpec.Source.BODY).getFirst().javaType());
        AdminClientOracle.Answer answer = adapter.call(e, request.args().pathValues(), request.args().query(), body);
        if (answer.request() == null) {
            throw new IllegalStateException("The admin client sent no request through " + e.javaChain() + ": "
                    + answer.observation().error());
        }
        return new Answer(answer.observation().status(), "admin client " + e.javaChain());
    }

    private Optional<Endpoint> binding(CaseRequest request) {
        boolean sendsBody = request.args().body() != null;
        List<Endpoint> candidates = bindings.getOrDefault(request.operationKey(), List.of()).stream()
                .filter(e -> e.params(ParamSpec.Source.BODY).isEmpty() != sendsBody).toList();
        return AdminClientOracle.binding(candidates, request.args().query().keySet());
    }
}
