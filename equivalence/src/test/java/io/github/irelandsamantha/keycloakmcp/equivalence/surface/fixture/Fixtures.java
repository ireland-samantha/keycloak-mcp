package io.github.irelandsamantha.keycloakmcp.equivalence.surface.fixture;

import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.DELETE;
import jakarta.ws.rs.FormParam;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.HttpMethod;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.util.List;
import java.util.Map;

/** Synthetic JAX-RS client interfaces covering every walker edge case the real admin client may grow into. */
public final class Fixtures {

    private Fixtures() {
    }

    public static final List<Class<?>> ALL = List.of(RootResource.class, ItemResource.class, NoteResource.class,
            PrefixedResource.class, PROPFIND.class, Orphan.class);

    @Target(ElementType.METHOD)
    @Retention(RetentionPolicy.RUNTIME)
    @HttpMethod("PROPFIND")
    public @interface PROPFIND {
    }

    @Path("/api")
    @Produces(MediaType.APPLICATION_JSON)
    public interface RootResource {

        @GET
        List<String> list(@QueryParam("first") Integer first, @QueryParam("brief") boolean brief);

        @GET
        List<String> list();

        default List<String> firstPage() {
            return list(0, true);
        }

        @Path("items/{id}")
        ItemResource item(@PathParam("id") String id);

        @GET
        @Path("tree/{path: .*}")
        String byPath(@PathParam("path") String path);

        @PROPFIND
        @Path("dav")
        Response dav();

        @Path("broken")
        ItemResource broken(@QueryParam("q") String q);

        @POST
        @Consumes({MediaType.APPLICATION_JSON, "application/yaml"})
        Response create(Map<String, Object> body);

        @POST
        @Path("form")
        @Consumes(MediaType.APPLICATION_FORM_URLENCODED)
        void form(@FormParam("a") String a, @FormParam("b") String b);

        @Path("prefixed")
        PrefixedResource prefixed();
    }

    public interface ItemResource {
        @GET
        Map<String, Object> get();

        @DELETE
        void delete();

        /** Same interface again: must be cut as a cycle. */
        @Path("children/{child}")
        ItemResource child(@PathParam("child") String child);

        /** Re-enters the root: also a cycle. */
        @Path("up")
        RootResource up();

        /** Repeats the variable name of the enclosing locator: /api/items/{id}/notes/{id}. */
        @Path("notes/{id}")
        NoteResource note(@PathParam("id") String id);
    }

    public interface NoteResource {
        @GET
        String read();
    }

    /** Class-level @Path on an interface also reached as a sub-resource: RESTEasy's client appends it. */
    @Path("inner")
    public interface PrefixedResource {
        @GET
        String hello();
    }

    /** Has JAX-RS methods but no root reaches it. */
    public interface Orphan {
        @GET
        String nobody();
    }
}
